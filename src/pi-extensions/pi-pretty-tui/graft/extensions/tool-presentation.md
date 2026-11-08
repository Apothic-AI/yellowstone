# extensions/tool-presentation.ts

- isThirdPartyTool · function · L10-L11 — isThirdPartyTool = (owner: any): boolean
- toolLabel · function · L13-L13 — toolLabel = (toolName: string, label?: string): string
- conciseThirdPartyArgs · function · L15-L36 — conciseThirdPartyArgs = (args: any): string
- thirdPartyResultSummary · function · L38-L51 — thirdPartyResultSummary = (component: any): string
- renderThirdPartyCompact · function · L53-L70 — renderThirdPartyCompact = (component: any, width: number, theme: any): string[]
- ToolProjection · type · L72-L80 — type ToolProjection = { lines: string[]; actions: Map<number, string>; toggleRows: Set<number>; // Coordinates of the original renderer inside the projection. sourceY // accounts for Pi's spacer, removed only by compact/clean presentation. native?: { x: number; y: number; width: number; height: number; sourceY: number }; sourceRows?: Map<number, number>; };
- nativeTimerRegion · function · L84-L101 — nativeTimerRegion = (owner: any, resultStart: number, contentWidth: number, width: number, rows: string[])
- height · function · L96-L96 — height = (items: any[])
- renderToolContent · function · L103-L204 — function renderToolContent( owner: any, width: number, theme: any, options: { mode: "full" | "compact"; nested: NestedTools; nestedExpanded: boolean; panels?: boolean; cardTitle?: string; renderNative: (width: number) => string[]; }, ): ToolProjection | undefined
- renderToolProjection · function · L207-L286 — function renderToolProjection( owner: any, width: number, theme: any, options: Parameters<typeof renderToolContent>[3], ): ToolProjection | undefined
