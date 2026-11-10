/** Teaching diagrams of the modeled machines: which chips the translated
 * game talks to, and how. They are not original electrical schematics. */
interface DiagramNode {
  id: string;
  label: string;
  detail: string;
  x: number;
  y: number;
  kind: 'cpu' | 'memory' | 'video' | 'sound' | 'input' | 'media';
}
interface SystemDiagram {
  title: string;
  nodes: DiagramNode[];
  links: [string, string, string][];
  note: string;
}

const diagrams: Record<string, SystemDiagram> = {
  c64: {
    title: 'Commodore 64 (PAL)',
    nodes: [
      { id: 'cpu', label: '6510 CPU', detail: 'Translated game code', x: 260, y: 30, kind: 'cpu' },
      {
        id: 'ram',
        label: '64 KB RAM',
        detail: 'Banked by port $01',
        x: 40,
        y: 140,
        kind: 'memory',
      },
      {
        id: 'rom',
        label: 'KERNAL services',
        detail: 'Reviewed system calls',
        x: 40,
        y: 250,
        kind: 'memory',
      },
      { id: 'vic', label: 'VIC-II', detail: 'Raster, sprites, IRQ', x: 260, y: 140, kind: 'video' },
      { id: 'sid', label: 'SID 6581', detail: 'Three voices', x: 480, y: 140, kind: 'sound' },
      {
        id: 'cia1',
        label: 'CIA 1',
        detail: 'Keyboard, joystick, timer',
        x: 480,
        y: 250,
        kind: 'input',
      },
      {
        id: 'disk',
        label: '1541 disk',
        detail: 'Original D64 media',
        x: 260,
        y: 250,
        kind: 'media',
      },
    ],
    links: [
      ['cpu', 'ram', 'reads/writes'],
      ['cpu', 'rom', 'JSR to services'],
      ['cpu', 'vic', '$D000 registers'],
      ['vic', 'ram', 'fetches screen'],
      ['cpu', 'sid', '$D400 registers'],
      ['cpu', 'cia1', '$DC00 ports'],
      ['vic', 'cpu', 'raster IRQ'],
      ['disk', 'ram', 'loads files'],
    ],
    note: 'CPU cycles are shared with VIC-II fetches (bad lines stall the CPU).',
  },
  nes: {
    title: 'Nintendo Entertainment System (PAL)',
    nodes: [
      { id: 'cpu', label: '2A07 CPU', detail: '6502 core + APU', x: 260, y: 30, kind: 'cpu' },
      { id: 'ram', label: '2 KB RAM', detail: '$0000–$07FF', x: 40, y: 140, kind: 'memory' },
      {
        id: 'cart',
        label: 'Cartridge',
        detail: 'PRG ROM, CHR, mapper',
        x: 40,
        y: 250,
        kind: 'media',
      },
      {
        id: 'ppu',
        label: '2C07 PPU',
        detail: 'Tiles, sprites, NMI',
        x: 260,
        y: 140,
        kind: 'video',
      },
      {
        id: 'apu',
        label: 'APU',
        detail: 'Pulse, triangle, noise, DMC',
        x: 480,
        y: 140,
        kind: 'sound',
      },
      { id: 'pad', label: 'Controller', detail: 'Serial at $4016', x: 480, y: 250, kind: 'input' },
      {
        id: 'vram',
        label: 'VRAM + OAM',
        detail: 'Name tables, sprites',
        x: 260,
        y: 250,
        kind: 'memory',
      },
    ],
    links: [
      ['cpu', 'ram', 'reads/writes'],
      ['cpu', 'cart', 'PRG reads, mapper writes'],
      ['cpu', 'ppu', '$2000 ports'],
      ['ppu', 'vram', 'renders'],
      ['ppu', 'cart', 'CHR fetches'],
      ['cpu', 'apu', '$4000 registers'],
      ['cpu', 'pad', 'strobe + shift'],
      ['ppu', 'cpu', 'NMI each frame'],
    ],
    note: 'The APU sits inside the CPU chip; the PPU raises NMI at vertical blank.',
  },
  n64: {
    title: 'Nintendo 64 (PAL)',
    nodes: [
      { id: 'cpu', label: 'VR4300 CPU', detail: '93.75 MHz MIPS', x: 260, y: 30, kind: 'cpu' },
      {
        id: 'ram',
        label: '4 MB RDRAM',
        detail: 'Shared by every unit',
        x: 40,
        y: 140,
        kind: 'memory',
      },
      { id: 'rsp', label: 'RSP', detail: 'Microcode: audio, Fast3D', x: 260, y: 140, kind: 'cpu' },
      {
        id: 'rdp',
        label: 'RDP',
        detail: 'Rasterizer → framebuffer',
        x: 480,
        y: 140,
        kind: 'video',
      },
      { id: 'vi', label: 'VI', detail: 'Scans framebuffer out', x: 480, y: 250, kind: 'video' },
      { id: 'ai', label: 'AI', detail: 'PCM DMA to DAC', x: 260, y: 250, kind: 'sound' },
      { id: 'pi', label: 'PI + cartridge', detail: 'ROM DMA', x: 40, y: 250, kind: 'media' },
      { id: 'si', label: 'SI + PIF', detail: 'Controller, EEPROM', x: 480, y: 30, kind: 'input' },
    ],
    links: [
      ['cpu', 'ram', 'reads/writes'],
      ['cpu', 'rsp', 'starts tasks'],
      ['rsp', 'ram', 'DMA'],
      ['rsp', 'rdp', 'commands'],
      ['rdp', 'ram', 'draws'],
      ['vi', 'ram', 'reads frame'],
      ['ai', 'ram', 'reads PCM'],
      ['pi', 'ram', 'DMA'],
      ['cpu', 'si', 'controller poll'],
    ],
    note: 'The RSP and RDP form the RCP. Desk steps the CPU and RSP; RDP work follows the RSP commands.',
  },
};

const svg = 'http://www.w3.org/2000/svg';

export function systemDiagram(system: string): HTMLElement {
  const spec = diagrams[system];
  const figure = document.createElement('figure');
  figure.className = 'desk-diagram';
  if (!spec) {
    figure.textContent = 'No diagram for this system.';
    return figure;
  }
  const width = 180,
    height = 64;
  const root = document.createElementNS(svg, 'svg');
  root.setAttribute('viewBox', '0 0 700 330');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', `Teaching diagram of the ${spec.title}`);
  const centre = new Map(spec.nodes.map((node) => [node.id, node]));
  for (const [from, to, label] of spec.links) {
    const a = centre.get(from)!,
      b = centre.get(to)!;
    const line = document.createElementNS(svg, 'line');
    const [x1, y1, x2, y2] = [a.x + width / 2, a.y + height / 2, b.x + width / 2, b.y + height / 2];
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('class', 'link');
    const title = document.createElementNS(svg, 'title');
    title.textContent = `${a.label} → ${b.label}: ${label}`;
    line.append(title);
    root.append(line);
  }
  for (const node of spec.nodes) {
    const group = document.createElementNS(svg, 'g');
    group.setAttribute('class', 'node ' + node.kind);
    const rect = document.createElementNS(svg, 'rect');
    rect.setAttribute('x', String(node.x));
    rect.setAttribute('y', String(node.y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('rx', '8');
    const label = document.createElementNS(svg, 'text');
    label.setAttribute('x', String(node.x + 12));
    label.setAttribute('y', String(node.y + 26));
    label.textContent = node.label;
    const detail = document.createElementNS(svg, 'text');
    detail.setAttribute('x', String(node.x + 12));
    detail.setAttribute('y', String(node.y + 46));
    detail.setAttribute('class', 'detail');
    detail.textContent = node.detail;
    group.append(rect, label, detail);
    root.append(group);
  }
  const caption = document.createElement('figcaption');
  caption.textContent = `Teaching diagram, not an original schematic. ${spec.title}. ${spec.note}`;
  const list = document.createElement('ul');
  list.className = 'desk-links';
  for (const [from, to, label] of spec.links) {
    const item = document.createElement('li');
    item.textContent = `${centre.get(from)!.label} → ${centre.get(to)!.label}: ${label}`;
    list.append(item);
  }
  figure.append(root, caption, list);
  return figure;
}
