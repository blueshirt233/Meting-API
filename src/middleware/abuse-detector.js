import store from '../admin/store.js'

// 默认配置
const DEFAULT_CONFIG = {
    enabled: true,
    rateLimit: {
        windowMs: 60000,
        maxRequests: 120,
        maxApiRequests: 60,
    },
    ban: {
        threshold: 3,
        duration: 3600000,
    },
    rules: {
        rapidRequests: true,
        invalidParams: true,
        pathEnumeration: true,
        suspiciousPatterns: true,
    },
    whitelist: {
        paths: ['/health', '/favicon.ico', '/', '/test'],
        ips: [],
    },
}

const SUSPICIOUS_PATTERNS = [
    /\.\.[\\/]/,
    /\0/,
    /<script/i,
    /javascript:/i,
    /union\s+select/i,
    /insert\s+into/i,
    /drop\s+table/i,
    /\${.*}/,
]

// 内存计数器: ip -> { count, apiCount, firstTime, lastTime, violations, paths: Set }
const requestRecords = new Map()
// 内存封禁列表: ip -> { reason, bannedAt, expiresAt }
const bannedIPs = new Map()

let lastCleanup = 0
const CLEANUP_INTERVAL = 5 * 60 * 1000

const getClientIP = (c) => {
    const forwarded = c.req.header('X-Forwarded-For')
    if (forwarded) {
        const ips = forwarded.split(',').map(s => s.trim())
        return ips[0] || 'unknown'
    }
    return c.req.header('X-Real-IP') || 'unknown'
}

const isWhitelisted = (path, ip, config) => {
    if (config.whitelist?.paths?.some(p => path === p || path.startsWith(p + '/'))) return true
    if (config.whitelist?.ips?.includes(ip)) return true
    return false
}

const cleanupExpired = () => {
    const now = Date.now()
    if (now - lastCleanup < CLEANUP_INTERVAL) return
    lastCleanup = now

    const windowMs = DEFAULT_CONFIG.rateLimit.windowMs * 2
    for (const [ip, record] of requestRecords) {
        if (now - record.lastTime > windowMs) {
            requestRecords.delete(ip)
        }
    }
    for (const [ip, ban] of bannedIPs) {
        if (ban.expiresAt && now > ban.expiresAt) {
            bannedIPs.delete(ip)
        }
    }
}

const detectAbuse = (c, ip, path, config) => {
    const now = Date.now()
    const violations = []

    let record = requestRecords.get(ip)
    if (!record) {
        record = {
            count: 0,
            apiCount: 0,
            firstTime: now,
            lastTime: now,
            violations: 0,
            paths: new Set(),
        }
        requestRecords.set(ip, record)
    }

    record.count++
    record.lastTime = now
    if (path.startsWith('/api')) {
        record.apiCount++
    }
    record.paths.add(path)

    // 检查封禁
    const banInfo = bannedIPs.get(ip)
    if (banInfo) {
        return {
            blocked: true,
            level: 'ban',
            reason: banInfo.reason,
            retryAfter: Math.ceil((banInfo.expiresAt - now) / 1000),
        }
    }

    const windowMs = config.rateLimit?.windowMs || DEFAULT_CONFIG.rateLimit.windowMs
    const maxRequests = config.rateLimit?.maxRequests || DEFAULT_CONFIG.rateLimit.maxRequests
    const maxApiRequests = config.rateLimit?.maxApiRequests || DEFAULT_CONFIG.rateLimit.maxApiRequests

    // 重置时间窗口
    if (now - record.firstTime > windowMs) {
        record.count = 1
        record.apiCount = path.startsWith('/api') ? 1 : 0
        record.firstTime = now
        record.paths.clear()
        record.paths.add(path)
    }

    // 规则1: 请求速率
    if (config.rules?.rapidRequests && record.count > maxRequests) {
        violations.push({
            type: 'rapid_requests',
            severity: 'medium',
            detail: `${record.count} requests in ${windowMs / 1000}s`,
        })
    }

    // 规则2: API 请求过多
    if (config.rules?.rapidRequests && record.apiCount > maxApiRequests) {
        violations.push({
            type: 'api_abuse',
            severity: 'high',
            detail: `${record.apiCount} API requests in ${windowMs / 1000}s`,
        })
    }

    // 规则3: 路径枚举
    if (config.rules?.pathEnumeration && record.paths.size > 30) {
        violations.push({
            type: 'path_enumeration',
            severity: 'medium',
            detail: `${record.paths.size} unique paths in window`,
        })
    }

    // 规则4: 可疑参数模式
    if (config.rules?.invalidParams) {
        const queryString = c.req.url
        for (const pattern of SUSPICIOUS_PATTERNS) {
            if (pattern.test(queryString) || pattern.test(path)) {
                violations.push({
                    type: 'suspicious_pattern',
                    severity: 'high',
                    detail: `Matched pattern: ${pattern.source}`,
                })
                break
            }
        }
    }

    if (violations.length === 0) {
        return { blocked: false, level: 'none', violations: [] }
    }

    record.violations++

    const maxSeverity = violations.some(v => v.severity === 'high')
        ? 'high'
        : violations.some(v => v.severity === 'medium')
            ? 'medium'
            : 'low'

    // 高危违规 + 累计违规次数达到阈值 -> 封禁
    const banThreshold = config.ban?.threshold || DEFAULT_CONFIG.ban.threshold
    const banDuration = config.ban?.duration || DEFAULT_CONFIG.ban.duration

    if (record.violations >= banThreshold && (maxSeverity === 'high' || record.violations >= banThreshold * 2)) {
        const reason = violations.map(v => v.type).join(',')
        bannedIPs.set(ip, {
            reason,
            bannedAt: now,
            expiresAt: now + banDuration,
        })
        store.addIpBan(ip, reason, banDuration, violations).catch(() => {})
        return {
            blocked: true,
            level: 'ban',
            reason,
            violations,
            retryAfter: Math.ceil(banDuration / 1000),
        }
    }

    return { blocked: false, level: maxSeverity, violations }
}

export const abuseDetectorMiddleware = async (c, next) => {
    const config = store.getAbuseConfig() || DEFAULT_CONFIG

    if (!config.enabled) {
        return await next()
    }

    cleanupExpired()

    const ip = getClientIP(c)
    const path = c.req.path

    if (isWhitelisted(path, ip, config)) {
        return await next()
    }

    const result = detectAbuse(c, ip, path, config)

    if (result.blocked) {
        await store.addAbuseLog({
            ip,
            path,
            method: c.req.method,
            level: 'ban',
            reason: result.reason,
            violations: result.violations || [],
            userAgent: c.req.header('User-Agent') || '',
            blocked: true,
        }).catch(() => {})

        c.status(429)
        return c.json({
            error: 'Too Many Requests',
            message: '请求过于频繁，请稍后再试',
            retryAfter: result.retryAfter,
        }, 429, {
            'Retry-After': String(result.retryAfter || 3600),
        })
    }

    if (result.level !== 'none' && result.violations.length > 0) {
        await store.addAbuseLog({
            ip,
            path,
            method: c.req.method,
            level: result.level,
            reason: result.violations.map(v => v.type).join(','),
            violations: result.violations,
            userAgent: c.req.header('User-Agent') || '',
            blocked: false,
        }).catch(() => {})
    }

    c.set('clientIP', ip)
    await next()
}

export const getAbuseStats = () => {
    return {
        activeRecords: requestRecords.size,
        bannedIPs: bannedIPs.size,
        topRequesters: Array.from(requestRecords.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10)
            .map(([ip, r]) => ({
                ip,
                count: r.count,
                apiCount: r.apiCount,
                violations: r.violations,
                lastTime: r.lastTime,
            })),
        bannedList: Array.from(bannedIPs.entries()).map(([ip, b]) => ({
            ip,
            reason: b.reason,
            bannedAt: b.bannedAt,
            expiresAt: b.expiresAt,
        })),
    }
}

export const banIP = (ip, reason, duration) => {
    const now = Date.now()
    const banDuration = duration || DEFAULT_CONFIG.ban.duration
    bannedIPs.set(ip, {
        reason: reason || 'manual_ban',
        bannedAt: now,
        expiresAt: now + banDuration,
    })
    store.addIpBan(ip, reason || 'manual_ban', banDuration, []).catch(() => {})
}

export const unbanIP = (ip) => {
    bannedIPs.delete(ip)
    store.removeIpBan(ip).catch(() => {})
}

export const isIPBanned = (ip) => bannedIPs.has(ip)

export const resetIPRecord = (ip) => {
    requestRecords.delete(ip)
}

export default abuseDetectorMiddleware
