/**
 * Deriving a Java package from a mod id.
 *
 * A mod id may contain `-`, may be a Java keyword, or may start with a digit; a
 * Java package segment may do none of those. Both the bridge scaffold and the L2
 * companion generator go through this function so the two cannot disagree about
 * where the generated class lives.
 */

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'record', 'sealed', 'permits', 'var'
])

export function javaPackageFor(modId: string): string {
  let segment = modId.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!/^[a-z_]/.test(segment)) segment = `m_${segment}`
  if (JAVA_KEYWORDS.has(segment)) segment = `${segment}_mod`
  return `com.modcrafting.${segment}`
}
