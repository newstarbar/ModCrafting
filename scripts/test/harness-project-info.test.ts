import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatGradleSummary,
  formatJavaFileList,
  MAX_JAVA_FILES_IN_PROMPT,
  parseGradleProperties,
  scanJavaSourceTree,
  toProjectRelativePath
} from '../../src/renderer/src/harness/project-info.ts'

test('toProjectRelativePath normalizes Windows separators', () => {
  assert.equal(
    toProjectRelativePath('F:\\proj\\src\\main\\java\\A.java', 'F:\\proj'),
    'src/main/java/A.java'
  )
})

test('formatJavaFileList shows empty marker', () => {
  assert.equal(
    formatJavaFileList([], '主源码 Java 文件'),
    '主源码 Java 文件：（无 .java 文件）\n'
  )
})

test('formatJavaFileList truncates with remainder count', () => {
  const files = Array.from({ length: MAX_JAVA_FILES_IN_PROMPT + 3 }, (_, i) => `src/a/F${i}.java`)
  const out = formatJavaFileList(files, '主源码 Java 文件')
  assert.match(out, new RegExp(`主源码 Java 文件（${files.length}）：`))
  assert.match(out, /…另有 3 个未列出/)
})

test('parseGradleProperties skips comments and blanks', () => {
  const props = parseGradleProperties(`
# Fabric
minecraft_version=1.21.4
loader_version=0.16.10

mod_version=1.0.0
`)
  assert.equal(props.minecraft_version, '1.21.4')
  assert.equal(props.loader_version, '0.16.10')
  assert.equal(props.mod_version, '1.0.0')
})

test('formatGradleSummary only includes known keys', () => {
  const out = formatGradleSummary({
    minecraft_version: '1.21.4',
    org_gradle_offline: 'true',
    maven_group: 'com.example'
  })
  assert.equal(
    out,
    'Gradle 属性：minecraft_version=1.21.4, maven_group=com.example\n'
  )
})

test('scanJavaSourceTree collects packages and java files', async () => {
  const tree: Record<string, Array<{ name: string; isDirectory: boolean; path: string }>> = {
    '/proj/src/main/java': [
      { name: 'com', isDirectory: true, path: '/proj/src/main/java/com' }
    ],
    '/proj/src/main/java/com': [
      { name: 'example', isDirectory: true, path: '/proj/src/main/java/com/example' }
    ],
    '/proj/src/main/java/com/example': [
      { name: 'Mod.java', isDirectory: false, path: '/proj/src/main/java/com/example/Mod.java' },
      { name: 'mixin', isDirectory: true, path: '/proj/src/main/java/com/example/mixin' }
    ],
    '/proj/src/main/java/com/example/mixin': [
      { name: 'FooMixin.java', isDirectory: false, path: '/proj/src/main/java/com/example/mixin/FooMixin.java' }
    ]
  }

  const { packages, javaFiles } = await scanJavaSourceTree(
    '/proj/src/main/java',
    '/proj',
    async (abs) => tree[abs] ?? []
  )

  assert.deepEqual(packages, ['com', 'com.example', 'com.example.mixin'])
  assert.deepEqual(javaFiles.sort(), [
    'src/main/java/com/example/Mod.java',
    'src/main/java/com/example/mixin/FooMixin.java'
  ])
})
