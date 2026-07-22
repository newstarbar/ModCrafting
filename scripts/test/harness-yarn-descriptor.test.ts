import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildOfficialToNamedMap,
  clearYarnClassMapCache,
  collectParamNames,
  formatYarnField,
  formatYarnMethod,
  getYarnOfficialToNamedMap,
  namedSimpleName,
  remapDescriptor
} from '../../src/main/yarn-descriptor.ts'

const SAMPLE_TINY = [
  'tiny\t2\t0\tofficial\tintermediary\tnamed',
  'c\tflk\tnet/minecraft/class_310\tnet/minecraft/client/MinecraftClient',
  'c\twp\tnet/minecraft/class_2561\tnet/minecraft/text/Text',
  'c\tfrd\tnet/minecraft/class_368\tnet/minecraft/client/toast/SystemToast',
  'c\tfrd$a\tnet/minecraft/class_368$class_369\tnet/minecraft/client/toast/SystemToast$Type',
  'c\takv\tnet/minecraft/class_2960\tnet/minecraft/util/Identifier',
  '\tf\tLfrd$a;\ta\tfield_type\ttype',
  '\tf\tLwp;\tb\tfield_title\ttitle',
  '\tm\t(Lflk;Lfrd$a;Lwp;Lwp;)Lfrd;\ta\tmethod_create\tcreate',
  '\t\tp\t0\t\t\tclient',
  '\t\tp\t1\t\t\ttype',
  '\t\tp\t2\t\t\ttitle',
  '\t\tp\t3\t\t\tdescription',
  '\tm\t()V\tb\tmethod_hide\thide',
  'c\tfev\tnet/minecraft/class_1011\tnet/minecraft/client/texture/NativeImage'
].join('\n')

test('namedSimpleName strips package and converts inner $', () => {
  assert.equal(
    namedSimpleName('net/minecraft/client/toast/SystemToast$Type'),
    'SystemToast.Type'
  )
  assert.equal(namedSimpleName('net/minecraft/client/MinecraftClient'), 'MinecraftClient')
})

test('buildOfficialToNamedMap maps official keys to named simple names', () => {
  const map = buildOfficialToNamedMap(SAMPLE_TINY.split('\n'))
  assert.equal(map.get('flk'), 'MinecraftClient')
  assert.equal(map.get('wp'), 'Text')
  assert.equal(map.get('frd'), 'SystemToast')
  assert.equal(map.get('frd$a'), 'SystemToast.Type')
  assert.equal(map.get('akv'), 'Identifier')
})

test('remapDescriptor remaps field types', () => {
  const map = buildOfficialToNamedMap(SAMPLE_TINY.split('\n'))
  assert.equal(remapDescriptor('Lflk;', map), 'MinecraftClient')
  assert.equal(remapDescriptor('Lfrd$a;', map), 'SystemToast.Type')
  assert.equal(remapDescriptor('I', map), 'int')
  assert.equal(remapDescriptor('[Lwp;', map), 'Text[]')
  // Unmapped JDK type: strip L; and convert separators
  assert.equal(remapDescriptor('Ljava/lang/String;', map), 'java.lang.String')
})

test('remapDescriptor remaps method descriptors to readable signatures', () => {
  const map = buildOfficialToNamedMap(SAMPLE_TINY.split('\n'))
  assert.equal(
    remapDescriptor('(Lflk;Lfrd$a;Lwp;Lwp;)Lfrd;', map),
    '(MinecraftClient, SystemToast.Type, Text, Text) -> SystemToast'
  )
  assert.equal(remapDescriptor('()V', map), '() -> void')
  assert.equal(
    remapDescriptor('(Lflk;I)V', map),
    '(MinecraftClient, int) -> void'
  )
})

test('formatYarnField and formatYarnMethod produce remapped output without bare L…;', () => {
  const map = buildOfficialToNamedMap(SAMPLE_TINY.split('\n'))
  const field = formatYarnField('type', 'Lfrd$a;', map)
  assert.equal(field, '  字段: type : SystemToast.Type')
  assert.doesNotMatch(field, /L[a-z0-9$]+;/)

  const method = formatYarnMethod('create', '(Lflk;Lfrd$a;Lwp;Lwp;)Lfrd;', map)
  assert.equal(
    method,
    '  方法: create(MinecraftClient, SystemToast.Type, Text, Text) -> SystemToast'
  )
  assert.doesNotMatch(method, /L[a-z0-9$]+;/)
})

test('formatYarnMethod includes param names when provided', () => {
  const map = buildOfficialToNamedMap(SAMPLE_TINY.split('\n'))
  const method = formatYarnMethod(
    'create',
    '(Lflk;Lfrd$a;Lwp;Lwp;)Lfrd;',
    map,
    ['client', 'type', 'title', 'description']
  )
  assert.equal(
    method,
    '  方法: create(client: MinecraftClient, type: SystemToast.Type, title: Text, description: Text) -> SystemToast'
  )
})

test('collectParamNames reads trailing p rows after a method', () => {
  const lines = SAMPLE_TINY.split('\n')
  // create method is at index 8 (0-based in SAMPLE_TINY lines)
  const createIdx = lines.findIndex((l) => l.includes('method_create'))
  assert.ok(createIdx >= 0)
  const { names, nextLine } = collectParamNames(lines, createIdx + 1)
  assert.equal(names[0], 'client')
  assert.equal(names[1], 'type')
  assert.equal(names[2], 'title')
  assert.equal(names[3], 'description')
  // nextLine should land on the hide method row
  assert.match(lines[nextLine], /method_hide/)
})

test('getYarnOfficialToNamedMap caches by mtime and remaps from real file content', () => {
  clearYarnClassMapCache()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yarn-desc-'))
  const tinyPath = path.join(dir, 'yarn-mappings.tiny')
  try {
    fs.writeFileSync(tinyPath, SAMPLE_TINY, 'utf-8')
    const map1 = getYarnOfficialToNamedMap(tinyPath)
    assert.equal(map1.get('flk'), 'MinecraftClient')

    const map2 = getYarnOfficialToNamedMap(tinyPath)
    assert.equal(map1, map2) // same cached instance

    // Simulate remapped exact-match style output
    const out = [
      formatYarnField('type', 'Lfrd$a;', map2),
      formatYarnMethod('create', '(Lflk;Lfrd$a;Lwp;Lwp;)Lfrd;', map2, ['client', 'type', 'title', 'description'])
    ].join('\n')
    assert.doesNotMatch(out, /L[a-z0-9/$]+;/)
    assert.match(out, /SystemToast\.Type/)
    assert.match(out, /MinecraftClient/)
  } finally {
    clearYarnClassMapCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
