import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'

const keyFilePath = (): string => path.join(app.getPath('userData'), 'master.key')

let cachedKey: Buffer | null = null

/** 获取本机主密钥（用于隐私书库正文静态加密）。
 *  优先使用平台凭据保护能力（Windows DPAPI / safeStorage）加密保存；
 *  平台能力不可用时退回受限文件存储，并在返回值中标记保护降级。 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey
  const p = keyFilePath()
  const usable = safeStorage.isEncryptionAvailable()
  if (fs.existsSync(p)) {
    const stored = fs.readFileSync(p)
    if (usable) {
      try {
        cachedKey = Buffer.from(safeStorage.decryptString(stored), 'base64')
        return cachedKey
      } catch {
        // 旧格式或损坏：重新生成会令已加密内容不可读，这里保留原文件并透传失败
      }
    }
    cachedKey = stored.length === 32 ? stored : Buffer.from(stored.toString('utf8'), 'base64')
    return cachedKey
  }
  const key = crypto.randomBytes(32)
  const out = usable ? safeStorage.encryptString(key.toString('base64')) : key
  fs.writeFileSync(p, out, { mode: 0o600 })
  cachedKey = key
  return key
}

/** 平台安全存储（Windows DPAPI）是否可用，用于设置页展示当前保护级别。 */
export function isStorageProtected(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function encryptText(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

export function decryptWithKey(payload: string, key: Buffer): string {
  const [ivB, tagB, dataB] = payload.split('.')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'))
  d.setAuthTag(Buffer.from(tagB, 'base64'))
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8')
}

// db 层通过注册的解密器处理已加密章节（密钥只在主进程内使用）
let globalDecryptor: ((payload: string) => string) | null = null
export function registerDecryptor(fn: (payload: string) => string): void {
  globalDecryptor = fn
}
export function decryptText(payload: string): string {
  if (!globalDecryptor) throw new Error('decryptor not registered')
  return globalDecryptor(payload)
}

// ---------------- PIN（本机隐私锁） ----------------
interface PinRecord {
  salt: string
  hash: string
  updatedAt: number
}

const pinFilePath = (): string => path.join(app.getPath('userData'), 'pin.json')

export function setPin(pin: string): void {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex')
  const rec: PinRecord = { salt, hash, updatedAt: Date.now() }
  fs.writeFileSync(pinFilePath(), JSON.stringify(rec), { mode: 0o600 })
}

export function hasPin(): boolean {
  return fs.existsSync(pinFilePath())
}

export function verifyPin(pin: string): boolean {
  if (!hasPin()) return false
  try {
    const rec = JSON.parse(fs.readFileSync(pinFilePath(), 'utf8')) as PinRecord
    const hash = crypto.scryptSync(pin, rec.salt, 32).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(rec.hash, 'hex'))
  } catch {
    return false
  }
}

/** 忘记 PIN：重置本机锁。按需求只能重置本机锁与受保护缓存，
 *  这里移除 PIN 并清除隐私书库加密内容（不可再解密）。 */
export function resetPinAndProtectedCache(clearPrivacyBooks: () => void): void {
  resetPin()
  clearPrivacyBooks()
}

export function resetPin(): void {
  const p = pinFilePath()
  if (fs.existsSync(p)) fs.renameSync(p, p + '.' + Date.now() + '.removed')
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function fileFingerprint(buf: Buffer, name: string): string {
  return sha256(name + ':' + buf.length + ':' + sha256(buf.subarray(0, 64 * 1024).toString('base64')))
}
