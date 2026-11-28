import type { BeforeMount } from '@monaco-editor/react'

export const configureEditorThemes: BeforeMount = monaco => {
  for (const dark of [false, true]) {
    monaco.editor.defineTheme(dark ? 'seekhein-dark' : 'seekhein-light', {
      base: dark ? 'vs-dark' : 'vs', inherit: true,
      rules: [
        { token: '', foreground: dark ? 'EEF2F7' : '182230' },
        { token: 'comment', foreground: dark ? 'ADB8C7' : '566274', fontStyle: '' },
        { token: 'keyword', foreground: dark ? 'CEB4EF' : '704399' },
        { token: 'string', foreground: dark ? '8BDFAD' : '17633E' },
        { token: 'number', foreground: dark ? 'F3CB7C' : '854D0E' },
        { token: 'delimiter', foreground: dark ? 'D8E0EC' : '283648' },
      ],
      colors: {
        'editor.background': dark ? '#1B212A' : '#FFFFFF',
        'editor.foreground': dark ? '#EEF2F7' : '#182230',
        'editorLineNumber.foreground': dark ? '#ADB8C7' : '#566274',
        'editorLineNumber.activeForeground': dark ? '#EEF2F7' : '#182230',
        'editorCursor.foreground': dark ? '#9EC5FF' : '#245BC5',
        'editor.selectionBackground': dark ? '#304C73' : '#DCE9FF',
        'editor.inactiveSelectionBackground': dark ? '#283241' : '#EDF0F4',
        'editor.lineHighlightBackground': dark ? '#242D39' : '#F4F6F8',
        'editor.lineHighlightBorder': '#00000000',
        'editorGutter.background': dark ? '#1B212A' : '#FFFFFF',
        'editorIndentGuide.background1': dark ? '#3C4758' : '#D5DCE5',
        'editorIndentGuide.activeBackground1': dark ? '#ADB8C7' : '#8794A5',
      },
    })
  }
}
