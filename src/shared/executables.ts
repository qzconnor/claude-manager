/**
 * Endings of files Windows runs when they are opened, instead of showing them: programs, installers,
 * scripts (Windows Script Host runs `.js` and `.vbs`), shortcuts and files that run something on
 * their own (help files with scripts, registry files, control panel items …). Like Chrome's list of
 * dangerous downloads.
 */
const WINDOWS = new Set([
  'ade', 'adp', 'app', 'application', 'appref-ms', 'appx', 'appxbundle', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt',
  'der', 'diagcab', 'diagcfg', 'diagpkg', 'exe', 'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'jar', 'jnlp', 'js', 'jse',
  'library-ms', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mde', 'mdt',
  'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh1xml', 'msh2', 'msh2xml', 'mshxml', 'msi', 'msix', 'msixbundle', 'msp', 'mst',
  'ops', 'pcd', 'pif', 'plg', 'prf', 'prg', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1', 'psm1', 'pst', 'reg',
  'scf', 'scr', 'sct', 'search-ms', 'searchconnector-ms', 'settingcontent-ms', 'shb', 'shs', 'url', 'vb', 'vbe', 'vbs', 'vsmacros',
  'vsw', 'ws', 'wsc', 'wsf', 'wsh', 'xbap', 'xll', 'xnk',
])

/** The same under Linux: programs and scripts a desktop may start rather than open in an editor. */
const LINUX = new Set(['appimage', 'bin', 'desktop', 'deb', 'exe', 'jar', 'msi', 'rpm', 'run', 'sh', 'snap', 'flatpakref'])

/** Whether opening the file with its default program runs it (or something it names) rather than showing it. */
export function runsWhenOpened(name: string, platform: string): boolean {
  let base = name.split(/[\\/]/).pop() ?? ''
  // Windows ignores dots and spaces at the end of a name: `a.exe.` runs too.
  if (platform === 'win32') base = base.replace(/[. ]+$/, '')
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return (platform === 'win32' ? WINDOWS : LINUX).has(base.slice(dot + 1).toLowerCase())
}
