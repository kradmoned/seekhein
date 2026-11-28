import type { BeforeMount } from '@monaco-editor/react'

export const configureEditorThemes: BeforeMount = monaco => {
  for (const dark of [false, true]) {
    monaco.editor.defineTheme(dark ? 'seekhein-dark' : 'seekhein-light', {
      base: dark ? 'vs-dark' : 'vs', inherit: true,
      rules: [
        { token: '', foreground: dark ? 'EEF0F3' : '182230' },
        { token: 'comment', foreground: dark ? 'B1B7C0' : '566274', fontStyle: '' },
        { token: 'keyword', foreground: dark ? 'CEB4EF' : '704399' },
        { token: 'string', foreground: dark ? '8BDFAD' : '17633E' },
        { token: 'number', foreground: dark ? 'F3CB7C' : '854D0E' },
        { token: 'delimiter', foreground: dark ? 'DCE0E6' : '283648' },
      ],
      colors: {
        'editor.background': dark ? '#202328' : '#FFFFFF',
        'editor.foreground': dark ? '#EEF0F3' : '#182230',
        'editorLineNumber.foreground': dark ? '#B1B7C0' : '#566274',
        'editorLineNumber.activeForeground': dark ? '#EEF0F3' : '#182230',
        'editorCursor.foreground': dark ? '#A5BBD8' : '#476B9D',
        'editor.selectionBackground': dark ? '#3A485B' : '#E2EAF4',
        'editor.inactiveSelectionBackground': dark ? '#2D3239' : '#EDF0F4',
        'editor.lineHighlightBackground': dark ? '#292D33' : '#F4F6F8',
        'editor.lineHighlightBorder': '#00000000',
        'editorGutter.background': dark ? '#202328' : '#FFFFFF',
        'editorIndentGuide.background1': dark ? '#424850' : '#D5DCE5',
        'editorIndentGuide.activeBackground1': dark ? '#B1B7C0' : '#8794A5',
      },
    })
  }
}
