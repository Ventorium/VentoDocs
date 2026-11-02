#!/usr/bin/env node
/**
 * WebDAV 冒烟测试（M2.44）。
 *
 * 前置：服务已启动（默认 8080），并存在两个可用账号（管理员 + 普通用户）。
 * 运行：
 *   VENTO_BASE=http://127.0.0.1:8080 \
 *   VENTO_ADMIN_USER=admin VENTO_ADMIN_PASS=... \
 *   VENTO_USER=alice VENTO_USER_PASS=... \
 *   node scripts/webdav-smoke.mjs
 *
 * 覆盖：OPTIONS/401/PROPFIND 三类顶级目录、个人目录读写/覆盖/范围请求、
 * COPY/MOVE（文件+目录）、LOCK/UNLOCK、lock-null、分享给我（只读越权）、
 * 团队共享、配额 507、清理。退出码非 0 表示失败。
 */
import assert from 'node:assert/strict'

const BASE = (process.env.VENTO_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '')
const DAV = BASE + '/dav'
const ADMIN = [process.env.VENTO_ADMIN_USER || 'admin', process.env.VENTO_ADMIN_PASS || '']
const USER = [process.env.VENTO_USER || 'alice', process.env.VENTO_USER_PASS || '']
const RUN = 'webdav_smoke_' + Date.now().toString(36)
const ADMIN_HEADERS = { authorization: basic(ADMIN) }
const USER_HEADERS = { authorization: basic(USER) }

if (!ADMIN[1] || !USER[1]) {
  console.error('缺少 VENTO_ADMIN_PASS / VENTO_USER_PASS')
  process.exit(2)
}

function basic([u, p]) {
  return 'Basic ' + Buffer.from(u + ':' + p).toString('base64')
}
function davUrl(path) {
  return DAV + '/' + path.split('/').map(encodeURIComponent).join('/')
}
async function dav(method, path, headers = {}, body) {
  const r = await fetch(davUrl(path), { method, headers, body })
  return { status: r.status, headers: r.headers, text: await r.text() }
}
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 保留文本 */ }
  return { status: r.status, json, text }
}
async function login([u, p]) {
  const r = await api('POST', '/api/v1/auth/login', null, { username: u, password: p })
  assert.equal(r.status, 200, '登录失败: ' + r.text)
  return r.json.token
}
async function rootChild(name) {
  const r = await api('GET', '/api/v1/directories/root', adminToken)
  return (r.json?.children || []).find((c) => c.kind === 'directory' && c.directory.name === name)?.directory.id
}

const adminToken = await login(ADMIN)
const userToken = await login(USER)
const userId = (await api('GET', '/api/v1/users', adminToken)).json.find((u) => u.username === USER[0])?.id
assert.ok(userId, '找不到普通用户: ' + USER[0])

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + (e?.message || e)) }
}
const eq = (actual, expected, msg) => assert.equal(actual, expected, msg)

let teamId = null
let dirName = null
let shareName = null
let quotaDirty = false
let teamDirName = null

try {
  console.log('== 基础 ==')
  await test('OPTIONS 免认证 200 + DAV 头', async () => {
    const r = await dav('OPTIONS', '')
    eq(r.status, 200); assert.match(r.headers.get('dav') || '', /1/)
  })
  await test('无认证 401 + WWW-Authenticate', async () => {
    const r = await dav('PROPFIND', '', { depth: '0' })
    eq(r.status, 401); assert.match(r.headers.get('www-authenticate') || '', /Basic/)
  })
  await test('错误密码 401', async () => {
    const r = await dav('PROPFIND', '', { authorization: basic([ADMIN[0], 'wrong']), depth: '0' })
    eq(r.status, 401)
  })
  await test('根目录 depth1 含三个顶级目录', async () => {
    const r = await dav('PROPFIND', '', { ...ADMIN_HEADERS, depth: '1' })
    eq(r.status, 207)
    for (const n of ['个人', '团队', '分享给我']) assert.ok(r.text.includes(n), '缺少 ' + n)
  })
  await test('Depth: infinity 拒绝 403', async () => {
    eq((await dav('PROPFIND', '个人', { ...ADMIN_HEADERS, depth: 'infinity' })).status, 403)
  })

  console.log('== 个人目录读写 ==')
  dirName = RUN
  await test('MKCOL 201', async () => eq((await dav('MKCOL', '个人/' + dirName, ADMIN_HEADERS)).status, 201))
  await test('目录已入库', async () => assert.ok(await rootChild(dirName)))
  await test('PUT 新文件 201', async () => eq((await dav('PUT', `个人/${dirName}/a.txt`, ADMIN_HEADERS, 'hello webdav')).status, 201))
  await test('GET 内容正确', async () => {
    const r = await dav('GET', `个人/${dirName}/a.txt`, ADMIN_HEADERS); eq(r.status, 200); eq(r.text, 'hello webdav')
  })
  await test('HEAD 头正确且无正文', async () => {
    const r = await dav('HEAD', `个人/${dirName}/a.txt`, ADMIN_HEADERS)
    eq(r.status, 200); eq(r.headers.get('content-length'), '12'); eq(r.text, '')
  })
  await test('Range 206', async () => {
    const r = await dav('GET', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, range: 'bytes=0-4' })
    eq(r.status, 206); eq(r.text, 'hello'); eq(r.headers.get('content-range'), 'bytes 0-4/12')
  })
  await test('PUT 覆盖 204 且内容更新', async () => {
    eq((await dav('PUT', `个人/${dirName}/a.txt`, ADMIN_HEADERS, 'hello 2')).status, 204)
    eq((await dav('GET', `个人/${dirName}/a.txt`, ADMIN_HEADERS)).text, 'hello 2')
  })
  await test('If-None-Match:* 覆盖 412', async () =>
    eq((await dav('PUT', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, 'if-none-match': '*' }, 'x')).status, 412))
  await test('PROPFIND depth1 列出文件与长度', async () => {
    const r = await dav('PROPFIND', `个人/${dirName}`, { ...ADMIN_HEADERS, depth: '1' })
    assert.ok(r.text.includes('a.txt') && r.text.includes('getcontentlength>7<'))
  })
  await test('PROPFIND 文件含 etag', async () => {
    const r = await dav('PROPFIND', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, depth: '0' })
    assert.ok(r.text.includes('a.txt') && r.text.includes('getetag'))
  })
  await test('PROPPATCH 207 兼容', async () =>
    eq((await dav('PROPPATCH', `个人/${dirName}/a.txt`, ADMIN_HEADERS, '<d:propertyupdate xmlns:d="DAV:"/>')).status, 207))

  console.log('== COPY / MOVE ==')
  await test('COPY 文件 201 且内容一致', async () => {
    eq((await dav('COPY', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, destination: davUrl(`个人/${dirName}/b.txt`) })).status, 201)
    eq((await dav('GET', `个人/${dirName}/b.txt`, ADMIN_HEADERS)).text, 'hello 2')
  })
  await test('MOVE 文件 201/源 404/目标内容一致', async () => {
    eq((await dav('MOVE', `个人/${dirName}/b.txt`, { ...ADMIN_HEADERS, destination: davUrl(`个人/${dirName}/c.txt`) })).status, 201)
    eq((await dav('GET', `个人/${dirName}/b.txt`, ADMIN_HEADERS)).status, 404)
    eq((await dav('GET', `个人/${dirName}/c.txt`, ADMIN_HEADERS)).text, 'hello 2')
  })
  await test('MOVE 目录保留子文件', async () => {
    await dav('MKCOL', `个人/${dirName}/sub`, ADMIN_HEADERS)
    eq((await dav('PUT', `个人/${dirName}/sub/d.txt`, ADMIN_HEADERS, 'dir content')).status, 201)
    eq((await dav('MOVE', `个人/${dirName}/sub`, { ...ADMIN_HEADERS, destination: davUrl(`个人/${dirName}/sub2`) })).status, 201)
    eq((await dav('GET', `个人/${dirName}/sub2/d.txt`, ADMIN_HEADERS)).text, 'dir content')
  })
  await test('目录移入自身 409', async () =>
    eq((await dav('MOVE', `个人/${dirName}/sub2`, { ...ADMIN_HEADERS, destination: davUrl(`个人/${dirName}/sub2/inner`) })).status, 409))

  console.log('== LOCK / UNLOCK ==')
  let lockToken = ''
  await test('LOCK 200 + 锁令牌', async () => {
    const r = await dav('LOCK', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, timeout: 'Second-600' },
      '<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>')
    lockToken = (r.headers.get('lock-token') || '').replace(/[<>]/g, '')
    eq(r.status, 200); assert.match(lockToken, /^urn:uuid:/)
  })
  await test('无锁令牌 PUT 423', async () =>
    eq((await dav('PUT', `个人/${dirName}/a.txt`, ADMIN_HEADERS, 'blocked')).status, 423))
  await test('携带锁令牌 PUT 204', async () =>
    eq((await dav('PUT', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, if: `(<${lockToken}>)` }, 'with lock')).status, 204))
  await test('UNLOCK 204 且可再写', async () => {
    eq((await dav('UNLOCK', `个人/${dirName}/a.txt`, { ...ADMIN_HEADERS, 'lock-token': `<${lockToken}>` })).status, 204)
    eq((await dav('PUT', `个人/${dirName}/a.txt`, ADMIN_HEADERS, 'after unlock')).status, 204)
  })
  await test('lock-null（Windows 新建流程）', async () => {
    const r = await dav('LOCK', `个人/${dirName}/new.txt`, ADMIN_HEADERS, '<d:lockinfo xmlns:d="DAV:"/>')
    const t = (r.headers.get('lock-token') || '').replace(/[<>]/g, '')
    eq(r.status, 200)
    eq((await dav('PUT', `个人/${dirName}/new.txt`, { ...ADMIN_HEADERS, if: `(<${t}>)` }, 'new')).status, 201)
    eq((await dav('UNLOCK', `个人/${dirName}/new.txt`, { ...ADMIN_HEADERS, 'lock-token': `<${t}>` })).status, 204)
  })

  console.log('== 分享给我（只读越权）==')
  shareName = RUN + '_share'
  await test('创建共享目录并授权只读', async () => {
    eq((await dav('MKCOL', '个人/' + shareName, ADMIN_HEADERS)).status, 201)
    const shareDir = await rootChild(shareName)
    assert.ok(shareDir)
    eq((await dav('PUT', `个人/${shareName}/s.txt`, ADMIN_HEADERS, 'shared content')).status, 201)
    const r = await api('PUT', `/api/v1/directories/${shareDir}/grants`, adminToken,
      { principal_type: 'user', principal_id: userId, perms: 3 })
    eq(r.status, 200, r.text)
  })
  await test('普通用户分享给我可见且可读', async () => {
    assert.ok((await dav('PROPFIND', '分享给我', { ...USER_HEADERS, depth: '1' })).text.includes(shareName))
    const r = await dav('GET', `分享给我/${shareName}/s.txt`, USER_HEADERS)
    eq(r.status, 200); eq(r.text, 'shared content')
  })
  await test('普通用户无写权限 PUT/DELETE 403', async () => {
    eq((await dav('PUT', `分享给我/${shareName}/s.txt`, USER_HEADERS, 'hack')).status, 403)
    eq((await dav('DELETE', `分享给我/${shareName}/s.txt`, USER_HEADERS)).status, 403)
  })
  await test('个人作用域不含他人目录', async () =>
    assert.ok(!(await dav('PROPFIND', '个人', { ...USER_HEADERS, depth: '1' })).text.includes(shareName)))

  console.log('== 团队 ==')
  teamDirName = RUN + '_teamdir'
  await test('创建团队/加成员/团队授权/可见可读', async () => {
    const t = await api('POST', '/api/v1/teams', adminToken, { name: RUN + '_team' })
    assert.ok(t.json?.id, t.text)
    teamId = t.json.id
    eq((await api('POST', `/api/v1/teams/${teamId}/members`, adminToken, { user_id: userId })).status, 200)
    eq((await dav('MKCOL', '个人/' + teamDirName, ADMIN_HEADERS)).status, 201)
    const teamDir = await rootChild(teamDirName)
    assert.ok(teamDir)
    eq((await dav('PUT', `个人/${teamDirName}/t.txt`, ADMIN_HEADERS, 'team content')).status, 201)
    eq((await api('PUT', `/api/v1/directories/${teamDir}/grants`, adminToken,
      { principal_type: 'team', principal_id: teamId, perms: 3 })).status, 200)
    assert.ok((await dav('PROPFIND', '团队', { ...USER_HEADERS, depth: '1' })).text.includes(teamDirName))
    eq((await dav('GET', `团队/${teamDirName}/t.txt`, USER_HEADERS)).text, 'team content')
  })

  console.log('== 配额 ==')
  await test('超配额 PUT 507', async () => {
    quotaDirty = true
    eq((await api('PUT', `/api/v1/users/${userId}/quota`, adminToken, { quota_bytes: 10 })).status, 200)
    eq((await dav('MKCOL', '个人/' + RUN + '_user', USER_HEADERS)).status, 201)
    eq((await dav('PUT', `个人/${RUN}_user/big.txt`, USER_HEADERS, '0123456789ABCDEF')).status, 507)
  })
} finally {
  console.log('== 清理 ==')
  if (shareName) await dav('DELETE', '个人/' + shareName, ADMIN_HEADERS)
  if (teamDirName) await dav('DELETE', '个人/' + teamDirName, ADMIN_HEADERS)
  if (dirName) await dav('DELETE', '个人/' + dirName, ADMIN_HEADERS)
  await dav('DELETE', '个人/' + RUN + '_user', USER_HEADERS)
  if (quotaDirty) await api('PUT', `/api/v1/users/${userId}/quota`, adminToken, { quota_bytes: null })
  if (teamId) {
    await api('DELETE', `/api/v1/teams/${teamId}/members/${userId}`, adminToken)
    await api('DELETE', `/api/v1/teams/${teamId}`, adminToken)
  }
  console.log(`\n== 结果: ${pass} passed, ${fail} failed ==`)
  process.exit(fail ? 1 : 0)
}
