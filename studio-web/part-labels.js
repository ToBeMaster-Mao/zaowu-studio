// Presentation labels only. Scene names and path IDs remain untouched so saved
// overrides, viewport selection, animation tracks and Agent context stay stable.
const categories = {
  fuselage: '机身', cockpit: '驾驶舱', cabin: '客舱与舷窗', wings: '机翼',
  engines: '发动机', tail: '尾翼', 'landing-gear': '起落架', details: '模型部件',
};
const sideName = side => String(side) === '-1' ? 'A侧' : 'B侧';
const numberLabel = index => String(Number(index) + 1).padStart(2, '0');
const sided = (label, side) => `${label} · ${sideName(side)}`;

const names = {
  Fuselage: ['机身外壳', '机身蒙皮'],
  Wing_body_fairing: ['翼身整流罩', '机翼与机身连接'],
  Vertical_stabilizer: ['垂直尾翼', '尾翼主体'],
  Fin_leading_edge: ['垂尾前缘', '尾翼边缘'],
  Landing_gear: ['起落架总成', '部件分组'],
  Nose_oleo: ['前起落架减震支柱', '前起落架'],
  Nose_upper_strut: ['前起落架上支柱', '前起落架'],
  Nose_drag_brace: ['前起落架斜撑', '前起落架'],
  Nose_axle: ['前轮轴', '前起落架'],
  Engine_pylon: ['发动机吊架', '发动机连接结构'],
  Pylon_fairing: ['吊架整流罩', '发动机连接结构'],
  Nacelle_outer: ['发动机外壳', '发动机短舱'],
  Intake_metal_lip: ['进气口边缘', '发动机进气口'],
  Intake_throat: ['进气道', '发动机进气口'],
  Rear_nozzle: ['尾喷口', '发动机排气结构'],
  Exhaust_cone: ['排气锥', '发动机排气结构'],
  Fan_backplate: ['风扇背板', '风扇结构'],
  Spinner: ['风扇中心锥', '发动机风扇'],
  Spinner_spiral: ['中心锥螺旋标记', '发动机风扇'],
  Top_beacon: ['机背信标灯', '机身灯光'],
  Bottom_beacon: ['机腹信标灯', '机身灯光'],
  Navigation_light: ['航行灯', '机翼灯光'],
  Dorsal_antenna: ['机背天线', '机身附件'],
  APU_exhaust: ['辅助动力排气口', '机尾附件'],
  Base_Foot: ['底座脚垫', '底座支撑'],
  Base: ['底座', '底部支撑'],
  Stem_Collar: ['支杆连接环', '支撑结构'],
  Stem: ['支杆', '支撑结构'],
  Curved_Arm: ['弧形支臂', '支撑结构'],
  Lampshade: ['灯罩总成', '部件分组'],
  Shade_Outer: ['灯罩外壳', '台灯灯罩'],
  Shade_Inner: ['灯罩内衬', '台灯灯罩'],
  Shade_Rim: ['灯罩边缘', '台灯灯罩'],
  Shade_Neck: ['灯罩连接颈', '台灯灯罩'],
  Bulb_Socket: ['灯泡座', '台灯光源'],
  Bulb: ['灯泡', '台灯光源'],
  Cup_Body: ['杯身', '杯子主体'],
  Cup_Handle: ['杯把', '杯子握持结构'],
  Cup_Rim: ['杯口', '杯子边缘'],
  Cup_Base: ['杯底', '杯子底部'],
};
const sideNames = {
  Main_wing: ['主机翼', '机翼主体'],
  Winglet: ['翼尖小翼', '机翼末端'],
  Horizontal_stabilizer: ['水平尾翼', '尾翼主体'],
  Wing_leading_edge: ['机翼前缘', '机翼边缘'],
  Winglet_leading_edge: ['小翼前缘', '翼尖边缘'],
  Elevator_hinge: ['升降舵铰链', '尾翼连接结构'],
  Rudder_hinge: ['方向舵铰链', '尾翼连接结构'],
  Belly_trim: ['机腹饰条', '机身细节'],
  Navigation_light: ['航行灯', '机翼灯光'],
  Nose_gear_door: ['前起落架舱门', '前起落架'],
  Main_gear_leg: ['主起落架支柱', '主起落架'],
  Main_gear_sleeve: ['主起落架套筒', '主起落架'],
  Main_gear_brace: ['主起落架斜撑', '主起落架'],
  Main_gear_axle: ['主轮轴', '主起落架'],
  Main_gear_door: ['主起落架舱门', '主起落架'],
  Engine: ['发动机总成', '部件分组'],
};

function engineSide(part) {
  // Use an explicit ancestor identifier; do not guess a side from coordinates.
  const path = String(part?.parentId || part?.id || part?.partId || '');
  return path.match(/(?:^|\/)Engine_(-1|1)(?:~\d+)?(?:\/|$)/)?.[1] || null;
}

function describe(value) {
  const part = typeof value === 'string' ? { name: value } : value || {};
  const name = String(part.name || '未命名部件');
  const engineContext = part.category === 'engines' || engineSide(part) !== null;
  let match;

  if ((match = name.match(/^Cockpit_(glass|frame)_(-1|1)_([0-2])$/))) {
    const glass = match[1] === 'glass';
    const labels = glass ? ['前风挡', '侧窗', '后侧窗'] : ['风挡框', '侧窗框', '后侧窗框'];
    return [sided(labels[Number(match[3])], match[2]), glass ? '驾驶舱玻璃' : '驾驶舱窗框'];
  }
  if ((match = name.match(/^(Window|WindowFrame)_(-1|1)_(\d+)$/))) {
    const frame = match[1] === 'WindowFrame';
    return [sided(`${frame ? '舷窗框' : '舷窗'} ${numberLabel(match[3])}`, match[2]), frame ? '客舱窗框' : '客舱玻璃'];
  }
  if ((match = name.match(/^Door_(outline|window|handle)_(-1|1)_([0-3])$/))) {
    const door = ['前舱门', '前应急出口', '后应急出口', '后舱门'][Number(match[3])];
    const suffix = { outline: '轮廓', window: '舷窗', handle: '把手' }[match[1]];
    return [sided(`${door}${suffix}`, match[2]), '客舱出入口'];
  }
  if ((match = name.match(/^(.*)_(-1|1)$/)) && Object.hasOwn(sideNames, match[1])) {
    const [label, detail] = sideNames[match[1]];
    return [sided(label, match[2]), detail];
  }
  if ((match = name.match(/^(Wing_panel_line|Spoiler_break|Flap_track_fairing)_(-1|1)_([\d.]+)$/))) {
    const type = {
      Wing_panel_line: ['机翼接缝', '机翼细节'],
      Spoiler_break: ['扰流板分界', '机翼细节'],
      Flap_track_fairing: ['襟翼轨道整流罩', '机翼下方结构'],
    }[match[1]];
    return [sided(type[0], match[2]), type[1]];
  }
  if ((match = name.match(/^Fuselage_panel_(-?[\d.]+)$/))) {
    return [`机身接缝 · ${Number(match[1]) < 0 ? '前段' : '后段'}`, '机身蒙皮分界'];
  }
  if ((match = name.match(/^Nacelle_panel_(-?[\d.]+)$/))) {
    const label = `短舱接缝 · ${Number(match[1]) < 0 ? '前段' : '后段'}`;
    const side = engineSide(part);
    return [side ? sided(label, side) : label, '发动机外壳细节'];
  }
  if ((match = name.match(/^Fan_(L|R)$/))) {
    return engineContext
      ? [sided('风扇总成', match[1] === 'L' ? '-1' : '1'), '发动机风扇']
      : [`风扇总成 · ${match[1]}`, '风扇结构'];
  }
  if ((match = name.match(/^Fan_blade_(\d+)$/))) {
    const label = `扇叶 ${numberLabel(match[1])}`;
    const side = engineSide(part);
    return [side ? sided(label, side) : label, engineContext ? '发动机风扇' : '风扇结构'];
  }
  if ((match = name.match(/^(Nose|Main)_tyre_(-1|1)(?:_(-?0\.42))?(_hub_bolt|_axle_cap|_hub)?$/))) {
    const main = match[1] === 'Main';
    const suffix = { _hub: '轮毂', _axle_cap: '轴盖', _hub_bolt: '轮毂螺栓' }[match[4]] || '轮胎';
    const wheel = main && match[3] ? ` ${Number(match[3]) < 0 ? '01' : '02'}` : '';
    return [sided(`${main ? '主轮' : '前轮'}${suffix}${wheel}`, match[2]), main ? '主起落架' : '前起落架'];
  }
  if (Object.hasOwn(names, name) && (engineContext || !['Spinner', 'Spinner_spiral'].includes(name))) {
    const [label, detail] = names[name];
    const side = engineSide(part);
    return [side ? sided(label, side) : label, engineContext && name === 'Fan_backplate' ? '发动机风扇' : detail];
  }
  // A custom model may use any naming convention, including Chinese. Keep that
  // user's wording; only replace separators as the original inspector did.
  return [name.replaceAll('_', ' '), Object.hasOwn(categories, part.category) ? categories[part.category] : (part.kind === 'group' ? '部件分组' : '模型部件')];
}

export const partLabel = part => describe(part)[0];
export const partDetail = part => describe(part)[1];
