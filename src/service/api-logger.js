/**
 * API 调用日志模块
 * 记录每次 /api 调用的详细信息，支持查询、过滤、分页和 CSV 导出
 */

import fs from 'fs'
import path from 'path'

const DATA_DIR = globalThis?.process?.env?.DATA_DIR || './data'
const LOGS_FILE = 'api_logs.json'
const MAX_LOGS = 5000

/** @type {Array<{id:string, timestamp:number, ip:string, server:string, type:string, requestId:string, status:string, statusCode:number, durationMs:number, songName:string, songArtist:string, error:string, userAgent:string}>} */
let logs = []

let saveTimer = null
const SAVE_INTERVAL = 2000 // 防抖保存间隔
let changed = false

// === 持久化 ===

const ensureDir = () => {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
    } catch (_) {}
}

const loadFromFile = () => {
    ensureDir()
    const filePath = path.join(DATA_DIR, LOGS_FILE)
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            if (Array.isArray(data)) {
                logs = data.slice(-MAX_LOGS)
            }
        }
    } catch (e) {
        console.log('[ApiLogger] 加载日志失败:', e.message)
    }
}

const saveToFile = () => {
    if (!changed) return
    changed = false
    ensureDir()
    try {
        const toSave = logs.slice(-MAX_LOGS)
        fs.writeFileSync(path.join(DATA_DIR, LOGS_FILE), JSON.stringify(toSave, null, 2))
    } catch (e) {
        console.log('[ApiLogger] 保存日志失败:', e.message)
    }
}

const scheduleSave = () => {
    changed = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveToFile, SAVE_INTERVAL)
}

// === 初始化 ===

loadFromFile()

// === IP 获取 ===

const getClientIP = (c) => {
    const forwarded = c?.req?.header('X-Forwarded-For')
    if (forwarded) {
        return forwarded.split(',')[0].trim()
    }
    return c?.req?.header('X-Real-IP') || 'unknown'
}

// === 歌曲信息提取 ===

const extractSongInfo = (data, type) => {
    if (!data) return { name: '', artist: '' }
    try {
        if (Array.isArray(data) && data.length > 0) {
            const song = data[0]
            return {
                name: song.name || song.title || '',
                artist: song.artist || song.author || (Array.isArray(song.artist) ? song.artist.join('/') : ''),
            }
        }
    } catch (_) {}
    return { name: '', artist: '' }
}

// === id 生成 ===

let idCounter = 0
const generateId = () => `${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 7)}`

// === 写入日志 ===

const addLog = (entry) => {
    const log = {
        id: generateId(),
        timestamp: Date.now(),
        ip: entry.ip || 'unknown',
        server: entry.server || '',
        type: entry.type || '',
        requestId: entry.requestId || '',
        status: entry.status || 'unknown',
        statusCode: entry.statusCode || 0,
        durationMs: entry.durationMs || 0,
        songName: entry.songName || '',
        songArtist: entry.songArtist || '',
        error: entry.error || '',
        userAgent: (entry.userAgent || '').slice(0, 256),
    }
    logs.push(log)
    if (logs.length > MAX_LOGS * 1.5) {
        logs = logs.slice(-MAX_LOGS)
    }
    scheduleSave()
}

// === 查询 ===

const getLogs = ({ startTime, endTime, ip, server, type, status, keyword, page = 1, pageSize = 50 } = {}) => {
    let filtered = [...logs]

    if (startTime) {
        const st = Number(startTime)
        if (!isNaN(st)) filtered = filtered.filter(l => l.timestamp >= st)
    }
    if (endTime) {
        const et = Number(endTime)
        if (!isNaN(et)) filtered = filtered.filter(l => l.timestamp <= et)
    }
    if (ip) {
        filtered = filtered.filter(l => l.ip.includes(ip))
    }
    if (server) {
        filtered = filtered.filter(l => l.server === server)
    }
    if (type) {
        filtered = filtered.filter(l => l.type === type)
    }
    if (status) {
        filtered = filtered.filter(l => l.status === status)
    }
    if (keyword) {
        const kw = keyword.toLowerCase()
        filtered = filtered.filter(l =>
            l.requestId.includes(kw) ||
            l.songName.toLowerCase().includes(kw) ||
            l.songArtist.toLowerCase().includes(kw) ||
            (l.error && l.error.toLowerCase().includes(kw))
        )
    }

    // 最新在前
    filtered.sort((a, b) => b.timestamp - a.timestamp)

    const total = filtered.length
    const totalPages = Math.ceil(total / pageSize) || 1
    const start = (page - 1) * pageSize
    const items = filtered.slice(start, start + pageSize)

    return { items, total, totalPages, page, pageSize }
}

// === 统计 ===

const getStats = () => {
    const now = Date.now()
    const last24h = now - 24 * 60 * 60 * 1000
    const recent = logs.filter(l => l.timestamp > last24h)
    
    const byServer = {}
    const byType = {}
    const byStatus = {}
    
    for (const l of recent) {
        byServer[l.server] = (byServer[l.server] || 0) + 1
        byType[l.type] = (byType[l.type] || 0) + 1
        byStatus[l.status] = (byStatus[l.status] || 0) + 1
    }

    const uniqueIPs = new Set(recent.map(l => l.ip)).size

    return {
        total: logs.length,
        last24h: recent.length,
        uniqueIPs24h: uniqueIPs,
        byServer,
        byType,
        byStatus,
    }
}

// === 清理 ===

const clearLogs = () => {
    logs = []
    changed = true
    saveToFile()
    return true
}

// === CSV 导出 ===

const BOM = '\uFEFF'

const escapeCSV = (val) => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
}

const exportCSV = ({ startTime, endTime, ip, server, type, status, keyword } = {}) => {
    const { items } = getLogs({ startTime, endTime, ip, server, type, status, keyword, page: 1, pageSize: 10000 })

    const headers = ['时间', 'IP地址', '平台', '类型', '请求ID', '状态码', '状态', '耗时(ms)', '歌曲名称', '歌手', '错误信息', 'User-Agent']
    const rows = items.map(l => [
        new Date(l.timestamp).toLocaleString('zh-CN'),
        l.ip,
        l.server,
        l.type,
        l.requestId,
        String(l.statusCode),
        l.status,
        String(l.durationMs),
        l.songName,
        l.songArtist,
        l.error,
        l.userAgent,
    ].map(escapeCSV).join(','))

    return BOM + [headers.join(','), ...rows].join('\n')
}

export default {
    addLog,
    getLogs,
    getStats,
    clearLogs,
    exportCSV,
    getClientIP,
    extractSongInfo,
}
