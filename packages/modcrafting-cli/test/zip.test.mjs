import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { assertSafeEntryName, createZip, readZip } from '../lib/zip.mjs'

test('round-trips a store-only archive', () => {
  const zip = createZip([['bundle.json', '{"a":1}'], ['dist/mcp-server.js', 'console.log(1)'], ['skills/x/SKILL.md', '---\nname: x\n---\n']])
  const files = readZip(zip)
  assert.deepEqual([...files.keys()], ['bundle.json', 'dist/mcp-server.js', 'skills/x/SKILL.md'])
  assert.equal(files.get('dist/mcp-server.js').toString(), 'console.log(1)')
})

test('reads deflated entries', () => {
  const source = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 37 + 11) % 251))
  const deflated = zlib.deflateRawSync(source)
  const zip = createZip([['a.txt', 'placeholder']])
  // Rebuild with a deflated entry by patching the local + central headers is fragile;
  // instead assert the inflate path directly through a handcrafted single-entry zip.
  const name = Buffer.from('big.txt')
  const crc = zlib.crc32(source)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(source.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(source.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  central.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16)
  const zip2 = Buffer.concat([local, name, deflated, central, name, eocd])
  assert.equal(readZip(zip2).get('big.txt').length, 5000)
  assert.ok(zip.length > 0)
})

test('rejects unsafe entry names', () => {
  for (const name of ['../evil', '/abs/x', 'C:/x', 'a\\..\\b', 'con.txt', 'trailing.', 'trailing ', 'x'.repeat(300)]) {
    assert.throws(() => assertSafeEntryName(name), /ZIP 校验失败/, name)
  }
})

test('rejects a corrupted data section', () => {
  const zip = createZip([['a.txt', 'hello world']])
  const corrupted = Buffer.from(zip)
  corrupted[corrupted.indexOf(Buffer.from('hello world'))] ^= 0xff
  assert.throws(() => readZip(corrupted), /CRC|解压|长度/)
})

test('rejects a truncated archive', () => {
  const zip = createZip([['a.txt', 'hello']])
  assert.throws(() => readZip(zip.slice(0, zip.length - 10)), /ZIP 校验失败/)
  assert.throws(() => readZip(Buffer.alloc(4)), /ZIP 校验失败/)
})
