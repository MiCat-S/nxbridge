export function embeddedSource<T extends string>(_language: 'csharp' | 'powershell' | 'sql' | 'javascript' | 'sh' | 'cmd', source: T): T {
  return source;
}
