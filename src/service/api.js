import Providers from "../providers/index.js"
import { format as lyricFormat, get_url } from "../util.js"
import store from "../admin/store.js"
import apiLogger from "./api-logger.js"

const parseCookieString = (cookieString) => {
    if (!cookieString) return {}
    const cookies = {}
    cookieString.split(';').forEach(item => {
        const [key, value] = item.trim().split('=')
        if (key && value) {
            cookies[key] = value
        }
    })
    return cookies
}

export default async (ctx) => {
    const startTime = Date.now()
    const ip = apiLogger.getClientIP(ctx)

    const p = new Providers()

    const query = ctx.req.query()
    const server = query.server || 'tencent'
    const type = query.type || 'playlist'
    const id = query.id || '7326220405'

    let logStatus = 'success'
    let logStatusCode = 200
    let logError = ''
    let songName = ''
    let songArtist = ''
    let logged = false

    try {
        if (!p.get_provider_list().includes(server) || !p.get(server).support_type.includes(type)) {
            ctx.status(400)
            logStatus = 'error'
            logStatusCode = 400
            logError = 'invalid server/type'
            return ctx.json({ status: 400, message: 'server 参数不合法', param: { server, type, id } })
        }

        // search 类型允许更宽松的 id（中文搜索词）
        if (type === 'search') {
            if (id.length > 256) {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'id too long'
                return ctx.json({ status: 400, message: 'id 参数过长' })
            }
            if (/[\x00-\x1f\x7f<>{}\\]/.test(id)) {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'invalid characters in id'
                return ctx.json({ status: 400, message: 'id 参数包含非法字符' })
            }
        } else {
            if (!/^[a-zA-Z0-9_,\s\-]+$/.test(id)) {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'invalid characters in id'
                return ctx.json({ status: 400, message: 'id 参数包含非法字符', param: { server, type, id } })
            }
            if (id.length > 256) {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'id too long'
                return ctx.json({ status: 400, message: 'id 参数过长' })
            }
        }

        let cookie = ''
        const storedCookie = store.getActiveCookie(server)
        if (storedCookie) {
            cookie = storedCookie.cookie
        }

        let data = await p.get(server).handle(type, id, cookie)

        if (type === 'url') {
            let url = data

            if (!url) {
                ctx.status(403)
                logStatus = 'error'
                logStatusCode = 403
                logError = 'no url'
                return ctx.json({ error: 'no url' })
            }
            if (url.startsWith('@')) {
                logStatusCode = 200
                apiLogger.addLog({ ip, server, type, requestId: id, status: 'success', statusCode: 200, durationMs: Date.now() - startTime, songName, songArtist, userAgent: ctx.req.header('User-Agent') || '' })
                logged = true
                return ctx.text(url)
            }

            try {
                const parsed = new URL(url)
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    ctx.status(400)
                    logStatus = 'error'
                    logStatusCode = 400
                    logError = 'invalid url protocol'
                    return ctx.json({ error: 'invalid url protocol' })
                }
            } catch {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'invalid url'
                return ctx.json({ error: 'invalid url' })
            }

            logStatusCode = 302
            apiLogger.addLog({ ip, server, type, requestId: id, status: 'success', statusCode: 302, durationMs: Date.now() - startTime, songName, songArtist, userAgent: ctx.req.header('User-Agent') || '' })
            logged = true
            return ctx.redirect(url)
        }

        if (type === 'pic') {
            try {
                const parsed = new URL(data)
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    ctx.status(400)
                    logStatus = 'error'
                    logStatusCode = 400
                    logError = 'invalid pic url protocol'
                    return ctx.json({ error: 'invalid pic url protocol' })
                }
            } catch {
                ctx.status(400)
                logStatus = 'error'
                logStatusCode = 400
                logError = 'invalid pic url'
                return ctx.json({ error: 'invalid pic url' })
            }
            logStatusCode = 302
            apiLogger.addLog({ ip, server, type, requestId: id, status: 'success', statusCode: 302, durationMs: Date.now() - startTime, songName, songArtist, userAgent: ctx.req.header('User-Agent') || '' })
            logged = true
            return ctx.redirect(data)
        }

        if (type === 'lrc') {
            const info = apiLogger.extractSongInfo([data], type)
            songName = info.name
            songArtist = info.artist
            apiLogger.addLog({ ip, server, type, requestId: id, status: 'success', statusCode: 200, durationMs: Date.now() - startTime, songName, songArtist, userAgent: ctx.req.header('User-Agent') || '' })
            logged = true
            return ctx.text(lyricFormat(data.lyric, data.tlyric || ''))
        }

        // song / playlist / search / artist 等类型
        const info = apiLogger.extractSongInfo(data, type)
        songName = info.name
        songArtist = info.artist

        apiLogger.addLog({ ip, server, type, requestId: id, status: 'success', statusCode: 200, durationMs: Date.now() - startTime, songName, songArtist, userAgent: ctx.req.header('User-Agent') || '' })
        logged = true

        return ctx.json(data.map(x => {
            for (let i of ['url', 'pic', 'lrc']) {
                const _ = String(x[i])
                if (!_.startsWith('@') && !_.startsWith('http') && _.length > 0) {
                    x[i] = `${get_url(ctx)}?server=${server}&type=${i}&id=${encodeURIComponent(_)}`
                }
            }
            return x
        }))
    } catch (e) {
        logStatus = 'error'
        logStatusCode = 500
        logError = e.message || 'unknown error'
        ctx.status(500)
        return ctx.json({ error: 'internal server error' })
    } finally {
        if (!logged) {
            apiLogger.addLog({ ip, server, type, requestId: id, status: logStatus, statusCode: logStatusCode, durationMs: Date.now() - startTime, songName, songArtist, error: logError, userAgent: ctx.req.header('User-Agent') || '' })
        }
    }
}
