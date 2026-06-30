import Providers from "../providers/index.js"
import { format as lyricFormat, get_url } from "../util.js"
import store from "../admin/store.js"

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

    const p = new Providers()

    const query = ctx.req.query()
    const server = query.server || 'tencent'
    const type = query.type || 'playlist'
    const id = query.id || '7326220405'

    if (!p.get_provider_list().includes(server) || !p.get(server).support_type.includes(type)) {
        ctx.status(400)
        return ctx.json({ status: 400, message: 'server 参数不合法', param: { server, type, id } })
    }

    // search 类型允许更宽松的 id（中文搜索词）
    if (type === 'search') {
        if (id.length > 256) {
            ctx.status(400)
            return ctx.json({ status: 400, message: 'id 参数过长' })
        }
        // 基本安全检查：不允许特殊控制字符
        if (/[\x00-\x1f\x7f<>{}\\]/.test(id)) {
            ctx.status(400)
            return ctx.json({ status: 400, message: 'id 参数包含非法字符' })
        }
    } else {
        // 非搜索类型：只允许字母数字
        if (!/^[a-zA-Z0-9_,\s\-]+$/.test(id)) {
            ctx.status(400)
            return ctx.json({ status: 400, message: 'id 参数包含非法字符', param: { server, type, id } })
        }
        if (id.length > 256) {
            ctx.status(400)
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
            return ctx.json({ error: 'no url' })
        }
        if (url.startsWith('@'))
            return ctx.text(url)

        try {
            const parsed = new URL(url)
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                ctx.status(400)
                return ctx.json({ error: 'invalid url protocol' })
            }
        } catch {
            ctx.status(400)
            return ctx.json({ error: 'invalid url' })
        }

        return ctx.redirect(url)
    }

    if (type === 'pic') {
        try {
            const parsed = new URL(data)
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                ctx.status(400)
                return ctx.json({ error: 'invalid pic url protocol' })
            }
        } catch {
            ctx.status(400)
            return ctx.json({ error: 'invalid pic url' })
        }
        return ctx.redirect(data)
    }

    if (type === 'lrc') {
        return ctx.text(lyricFormat(data.lyric, data.tlyric || ''))
    }


    return ctx.json(data.map(x => {
        for (let i of ['url', 'pic', 'lrc']) {
            const _ = String(x[i])
            if (!_.startsWith('@') && !_.startsWith('http') && _.length > 0) {
                x[i] = `${get_url(ctx)}?server=${server}&type=${i}&id=${encodeURIComponent(_)}`
            }
        }
        return x
    }))
}
