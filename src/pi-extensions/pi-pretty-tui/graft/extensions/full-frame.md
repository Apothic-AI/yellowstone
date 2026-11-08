# extensions/full-frame.ts

- NativeFrame · type · L5-L7 — type NativeFrame = { lines: string[]; sourceRows: Map<number, number>; contentWidth: number; inset: number; };
- cardMargin · function · L11-L11 — cardMargin = (width: number)
- nativeFrameWidth · function · L12-L15 — nativeFrameWidth = (width: number)
- cardBackground · function · L18-L37 — cardBackground = (line: string, width: number, theme: any, role = "toolPendingBg", borderRole?: string): string
- renderPanel · function · L40-L84 — function renderPanel( title: string, source: string[], width: number, theme: any, sections = new Map<number, { label: string; color: string }>(), cacheOwner?: object, titleColor = "text", footer = "", borderColor = "borderMuted", background = "toolPendingBg", ): NativeFrame
- border · function · L58-L58 — border = (s: string)
- frameNativeRows · function · L89-L105 — function frameNativeRows( title: string, source: string[], width: number, theme: any, sections = new Map<number, { label: string; color: string }>(), cacheOwner?: object, titleColor = "text", footer = "", borderColor = "borderMuted", background = "toolPendingBg", ): NativeFrame
- trimmedIndices · function · L107-L114 — trimmedIndices = (source: string[], start: number, end: number): number[]
- frameNativeToolRows · function · L117-L134 — function frameNativeToolRows( title: string, source: string[], width: number, theme: any, resultStart: number | undefined, resultColor: string, owner: object, footer = "", ): NativeFrame
