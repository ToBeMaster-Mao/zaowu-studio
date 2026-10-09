import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Metres. X: nose to tail; Y: up; Z: span. Built from geometry, not image planes.
export function createAirliner() {
  const aircraft = new THREE.Group();
  aircraft.name = 'Reference_Airliner';
  aircraft.userData = { description: 'Procedural interpretation of the supplied airliner photograph', units: 'metres', approximate: true };
  const makeMaterial = (color, roughness = 0.4, metalness = 0.05) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const materials = {
    white: makeMaterial('#eef1f2', 0.27, 0.18),
    wing: makeMaterial('#dce2e5', 0.35, 0.24),
    teal: makeMaterial('#075367', 0.28, 0.32),
    glass: makeMaterial('#142d38', 0.16, 0.52),
    silver: makeMaterial('#a6b1b8', 0.26, 0.78),
    seam: makeMaterial('#75858d', 0.62, 0.22),
    dark: makeMaterial('#171d22', 0.48, 0.25),
    rubber: makeMaterial('#202326', 0.85, 0.02),
    fan: makeMaterial('#424e55', 0.36, 0.75),
    red: makeMaterial('#cf3f33', 0.3, 0.1),
    green: makeMaterial('#25ac86', 0.3, 0.1),
  };
  for (const [name, material] of Object.entries(materials)) material.name = name;
  const meshes = [];
  function mesh(geometry, material, name, parent = aircraft) {
    const object = new THREE.Mesh(geometry, material);
    object.name = name;
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    meshes.push(object);
    return object;
  }
  function ellipsoid(name, center, radii, material, parent = aircraft) {
    const object = mesh(new THREE.SphereGeometry(1, 32, 18), material, name, parent);
    object.position.set(...center);
    object.scale.set(...radii);
    return object;
  }
  function rod(name, start, end, radius, material, parent = aircraft) {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
    const object = mesh(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12), material, name, parent);
    object.position.copy(a).add(b).multiplyScalar(0.5);
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    return object;
  }
  function line(name, points, material = materials.seam, radius = 0.01, parent = aircraft) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
    return mesh(new THREE.TubeGeometry(curve, Math.max(12, points.length * 3), radius, 5, false), material, name, parent);
  }
  // A monotone cubic profile keeps the nose and tail smooth without radius overshoot.
  const stations = [
    [-18.8, 3.56, 0.035, 0.04], [-18.71, 3.57, 0.28, 0.32], [-18.45, 3.59, 0.56, 0.62],
    [-17.65, 3.72, 0.91, 1.02], [-16.4, 3.94, 1.36, 1.44],
    [-14.7, 4.13, 1.76, 1.77], [-12.7, 4.2, 1.91, 1.91],
    [-9, 4.2, 1.94, 1.94], [7.8, 4.2, 1.94, 1.94],
    [10.6, 4.23, 1.86, 1.86], [13.4, 4.38, 1.5, 1.5],
    [15.7, 4.64, 0.97, 0.98], [17.65, 4.88, 0.43, 0.43],
    [18.7, 4.94, 0.06, 0.07], [18.85, 4.94, 0.008, 0.008],
  ];
  function profile(x, column) {
    let i = 0;
    while (i < stations.length - 2 && x > stations[i + 1][0]) i++;
    const a = stations[i], b = stations[i + 1];
    const slope = k => (stations[k + 1][column] - stations[k][column]) / (stations[k + 1][0] - stations[k][0]);
    const tangent = k => {
      if (k === 0) return slope(0);
      if (k === stations.length - 1) return slope(k - 1);
      const p = slope(k - 1), q = slope(k);
      return p * q <= 0 ? 0 : 2 * p * q / (p + q);
    };
    const h = b[0] - a[0], t = THREE.MathUtils.clamp((x - a[0]) / h, 0, 1);
    return (2*t*t*t-3*t*t+1)*a[column] + (t*t*t-2*t*t+t)*h*tangent(i)
      + (-2*t*t*t+3*t*t)*b[column] + (t*t*t-t*t)*h*tangent(i+1);
  }
  function surface(x, theta, offset = 0) {
    return [x, profile(x, 1) + (profile(x, 2) + offset) * Math.cos(theta), (profile(x, 3) + offset) * Math.sin(theta)];
  }
  const bodyPositions = [], bodyIndices = [], bodyUV = [];
  const longSegments = 224, ringSegments = 96;
  for (let i = 0; i <= longSegments; i++) {
    const x = -18.8 + 37.65 * i / longSegments;
    for (let j = 0; j <= ringSegments; j++) {
      bodyPositions.push(...surface(x, j / ringSegments * Math.PI * 2));
      bodyUV.push(i / longSegments, j / ringSegments);
    }
  }
  const bodyGeometry = new THREE.BufferGeometry();
  bodyGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bodyPositions, 3));
  bodyGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(bodyUV, 2));
  const bodyMaterialIndices = [[], []];
  for (let i = 0; i < longSegments; i++) {
    for (let j = 0; j < ringSegments; j++) {
      const a = i * (ringSegments + 1) + j, b = a + ringSegments + 1;
      const materialIndex = Math.cos((j + 0.5) / ringSegments * Math.PI * 2) < -0.40 ? 1 : 0;
      bodyMaterialIndices[materialIndex].push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  for (let i = 0; i < 2; i++) {
    bodyGeometry.addGroup(bodyIndices.length, bodyMaterialIndices[i].length, i);
    for (const index of bodyMaterialIndices[i]) bodyIndices.push(index);
  }
  bodyGeometry.setIndex(bodyIndices);
  bodyGeometry.computeVertexNormals();
  mesh(bodyGeometry, [materials.white, materials.teal], 'Fuselage');

  // Small, curved surface patches follow the fuselage. Frames remain separate geometry.
  function surfacePatch(name, outline, material, offset = 0.016, mapPoint = (a,b)=>surface(a,b,offset)) {
    const shape = outline.map(p => new THREE.Vector2(p[0], p[1]));
    const triangles = THREE.ShapeUtils.triangulateShape(shape, []);
    const p = [];
    for (const triangle of triangles) {
      const subdivisions = name.startsWith('Cockpit') ? 10 : 2;
      const [a,b,c] = triangle.map(index=>outline[index]);
      const sample=(i,j)=>mapPoint(a[0]+(b[0]-a[0])*i/subdivisions+(c[0]-a[0])*j/subdivisions,a[1]+(b[1]-a[1])*i/subdivisions+(c[1]-a[1])*j/subdivisions);
      for(let i=0;i<subdivisions;i++)for(let j=0;j<subdivisions-i;j++){
        p.push(...sample(i,j),...sample(i+1,j),...sample(i,j+1));
        if(i+j<subdivisions-1)p.push(...sample(i+1,j),...sample(i+1,j+1),...sample(i,j+1));
      }
    }
    // Surface-patch triangulation has a 2D winding; correct it after projection.
    // Inward normals reverse shadow normalBias even on a double-sided material.
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const edgeB = new THREE.Vector3(), edgeC = new THREE.Vector3(), outward = new THREE.Vector3();
    for (let i = 0; i < p.length; i += 9) {
      a.fromArray(p, i); b.fromArray(p, i + 3); c.fromArray(p, i + 6);
      const x = (a.x + b.x + c.x) / 3;
      outward.set(0, (a.y + b.y + c.y) / 3 - profile(x, 1), (a.z + b.z + c.z) / 3);
      if (edgeB.subVectors(b, a).cross(edgeC.subVectors(c, a)).dot(outward) < 0) {
        for (let axis = 0; axis < 3; axis++) {
          const value = p[i + 3 + axis]; p[i + 3 + axis] = p[i + 6 + axis]; p[i + 6 + axis] = value;
        }
      }
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    // Weld positions before computing normals so glass reflects as one smooth surface.
    const smoothGeometry = mergeVertices(geometry, 1e-5);
    geometry.dispose();
    geometry = smoothGeometry;
    geometry.computeVertexNormals();
    const object = mesh(geometry, material, name);
    object.castShadow = false;
    // Windings on the two fuselage sides differ; patch geometry uses a shared double-sided material.
    object.material.side = THREE.DoubleSide;
    return object;
  }
  // Project a straight-edged windshield outline onto the nose along the X axis.
  // Interpolating height/span first avoids scalloped top and bottom edges in front view.
  function cockpitSurface(height, span, offset) {
    let lo=-18.799,hi=-12.7;
    for(let step=0;step<32;step++){
      const x=(lo+hi)/2;
      const distance=((height-profile(x,1))/profile(x,2))**2+(span/profile(x,3))**2;
      if(distance>1)lo=x;else hi=x;
    }
    const x=(lo+hi)/2;
    const theta=Math.atan2(span/profile(x,3),(height-profile(x,1))/profile(x,2));
    return surface(x,theta,offset);
  }
  function roundOutline(x, theta, w, h, r) {
    const result = [];
    for (const [cx, cy, begin] of [[w/2-r,h/2-r,0],[-w/2+r,h/2-r,Math.PI/2],[-w/2+r,-h/2+r,Math.PI],[w/2-r,-h/2+r,Math.PI*1.5]]) {
      for (let k = 0; k <= 5; k++) {
        const a = begin + k / 5 * Math.PI / 2;
        result.push([x + cx + r * Math.cos(a), theta + (cy + r * Math.sin(a)) / 1.94]);
      }
    }
    return result;
  }
  const doors = [-12.7, -1.2, 1.0, 12.1];
  for (const side of [-1, 1]) {
    const theta = side * 1.19;
    let index = 0;
    for (let x = -11.45; x <= 11.5; x += 0.51) {
      if (doors.some(d => Math.abs(d - x) < 0.49)) continue;
      surfacePatch(`WindowFrame_${side}_${index}`, roundOutline(x, theta, 0.257, 0.40, 0.115), materials.silver, 0.018);
      surfacePatch(`Window_${side}_${index++}`, roundOutline(x, theta, 0.209, 0.351, 0.092), materials.glass, 0.028);
    }
    doors.forEach((x, i) => {
      const exit = i === 1 || i === 2;
      const outline = roundOutline(x, side * (exit ? 1.24 : 1.43), exit ? 0.59 : 0.91, exit ? 1.04 : 1.87, 0.12);
      const points = [...outline, outline[0]].map(p => surface(p[0], p[1], 0.027));
      line(`Door_outline_${side}_${i}`, points, materials.seam, 0.013);
      surfacePatch(`Door_window_${side}_${i}`, roundOutline(x, side * 1.17, 0.20, 0.31, 0.085), materials.glass, 0.034);
      const h = surface(x + 0.26, side * (exit ? 1.51 : 1.64), 0.04);
      rod(`Door_handle_${side}_${i}`, [h[0]-0.06,h[1],h[2]], [h[0]+0.06,h[1],h[2]], 0.019, materials.silver);
    });
    // Front windscreens meet at a narrow centre mullion, then wrap into two side panes.
    // X/theta coordinates keep the front panes on the forward slope of the nose.
    const windscreens = [
      [[-17.36,.025],[-16.38,.025],[-15.62,.77],[-16.47,1.015]],
      [[-16.36,1.045],[-15.52,.80],[-14.83,.97],[-15.03,1.25]],
      [[-14.91,1.265],[-14.72,.995],[-14.29,1.14],[-14.36,1.32]],
    ];
    windscreens.forEach((polygon,i) => {
      const outline = polygon.map(([x,t])=>{
        const point=surface(x,side*t);return [point[1],point[2]];
      });
      surfacePatch(`Cockpit_glass_${side}_${i}`, outline, materials.glass, 0.028, (y,z)=>cockpitSurface(y,z,.028));
      // Sample each straight polygon edge before mapping onto the curved skin.
      // Interpolating only the corners made the old frames bulge away from the glass.
      const framePoints=[];
      for(let edge=0;edge<outline.length;edge++){
        const a=outline[edge],b=outline[(edge+1)%outline.length];
        for(let step=0;step<16;step++){
          const t=step/16;
          framePoints.push(cockpitSurface(THREE.MathUtils.lerp(a[0],b[0],t),THREE.MathUtils.lerp(a[1],b[1],t),.039));
        }
      }
      framePoints.push(framePoints[0]);
      line(`Cockpit_frame_${side}_${i}`, framePoints, materials.silver, 0.014);
    });
    line(`Belly_trim_${side}`, Array.from({length:100},(_,i)=>surface(-17.6+34.8*i/99,side*1.9635,0.014)), materials.silver, 0.012);
  }
  for (const x of [-17.4,-14.3,13.1,16.55]) {
    line(`Fuselage_panel_${x}`, Array.from({length:97},(_,i)=>surface(x,i/96*Math.PI*2,0.01)), materials.seam, 0.006);
  }
  ellipsoid('Wing_body_fairing',[1.5,2.98,0],[6.1,0.64,2.12],materials.teal);

  function thickness(u, chord, ratio = 0.105) {
    return 5*ratio*chord*(0.2969*Math.sqrt(u)-0.126*u-0.3516*u*u+0.2843*u*u*u-0.1036*u*u*u*u);
  }
  // Airfoil sections: span, leading-edge X, trailing-edge X, centre Y.
  const wingSections = [[1.35,-4.25,6.1,3.20],[3.3,-3.13,6.28,3.18],[6,-1.53,6.1,3.43],[10.7,1.34,7.03,3.99],[15.3,4.45,7.63,4.64],[16.8,5.56,7.88,5.02]];
  const wingletSections = [[16.8,5.56,7.88,5.02],[17.3,5.91,7.98,5.34],[17.60,6.46,8.1,6.05],[17.77,7.16,8.28,7.39],[17.8,7.65,8.37,8.02]];
  const tailSections = [[0.6,12.0,17.5,4.75],[3.0,13.68,17.65,5.02],[6.7,16.28,18.1,5.59]];
  function airfoil(name, sections, side, material, ratio = 0.105) {
    const verts = [], indices = [], n = 30;
    const ring = [];
    for(let i=0;i<=n;i++)ring.push([0.5*(1-Math.cos(i/n*Math.PI)),1]);
    for(let i=n-1;i>0;i--)ring.push([0.5*(1-Math.cos(i/n*Math.PI)),-1]);
    sections.forEach(([z,le,te,y])=>{
      ring.forEach(([u,s])=>{
        const camber = .012*(te-le)*Math.sin(u*Math.PI);
        verts.push(le+(te-le)*u, y + s*thickness(u,te-le,ratio)+camber, side*z);
      });
    });
    const count = ring.length;
    for(let i=0;i<sections.length-1;i++)for(let j=0;j<count;j++){
      const a=i*count+j,b=i*count+(j+1)%count,c=a+count,d=b+count;
      if(side===1)indices.push(a,b,c,b,d,c);else indices.push(a,c,b,b,c,d);
    }
    for(const row of [0,sections.length-1]){
      const section=sections[row],center=verts.length/3;
      verts.push((section[1]+section[2])/2,section[3],side*section[0]);
      for(let j=0;j<count;j++)indices.push(center,row*count+j,row*count+(j+1)%count);
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));g.setIndex(indices);g.computeVertexNormals();
    const result=mesh(g,material,name);material.side=THREE.DoubleSide;return result;
  }
  function wingPoint(section,u,side,extra=.012){
    const [z,le,te,y]=section;
    return [le+(te-le)*u,y+thickness(u,te-le)+.012*(te-le)*Math.sin(u*Math.PI)+extra,side*z];
  }
  for(const side of [-1,1]){
    airfoil(`Main_wing_${side}`,wingSections,side,materials.wing);
    airfoil(`Winglet_${side}`,wingletSections,side,materials.teal,.085);
    airfoil(`Horizontal_stabilizer_${side}`,tailSections,side,materials.wing,.085);
    // Leading-edge metallic strip follows the actual airfoil contour.
    line(`Wing_leading_edge_${side}`,wingSections.map(s=>wingPoint(s,.012,side)),materials.silver,.043);
    line(`Winglet_leading_edge_${side}`,wingletSections.map(s=>[s[1]+.025,s[3],side*s[0]]),materials.silver,.034);
    for(const u of [.15,.69,.83])line(`Wing_panel_line_${side}_${u}`,wingSections.map(s=>wingPoint(s,u,side)),materials.seam,.008);
    for(const section of wingSections.slice(1,-1))line(`Spoiler_break_${side}_${section[0]}`,[wingPoint(section,.5,side),wingPoint(section,.71,side),wingPoint(section,.97,side)],materials.seam,.009);
    line(`Elevator_hinge_${side}`,tailSections.map(s=>wingPoint(s,.72,side)),materials.seam,.009);
    for(const z of [4.2,7.1,10.2]){
      const s=wingSections.findIndex(v=>v[0]>z), a=wingSections[s-1],b=wingSections[s],t=(z-a[0])/(b[0]-a[0]);
      const te=THREE.MathUtils.lerp(a[2],b[2],t),y=THREE.MathUtils.lerp(a[3],b[3],t);
      ellipsoid(`Flap_track_fairing_${side}_${z}`,[te-.1,y-.18,side*z],[1.05,.19,.16],materials.wing);
    }
    ellipsoid(`Navigation_light_${side}`,[7.85,5.18,side*16.9],[.12,.09,.10],side===1?materials.green:materials.red);
  }
  // Vertical tail: swept airfoil with a flared root and a teal rudder.
  const finSections=[[5.38,10.2,17.35,.26],[6.2,11.35,17.46,.22],[7.0,12.32,17.53,.20],[12.2,15.34,18.00,.075],[12.58,15.54,18.03,.055]];
  const finVerts=[],finIndices=[],finSteps=32;
  for(const [y,le,te,w] of finSections){
    for(let j=0;j<finSteps;j++){
      const angle=j/finSteps*Math.PI*2,u=(1-Math.cos(angle))/2;
      finVerts.push(le+(te-le)*u,y,Math.sin(angle)*w);
    }
  }
  for(let i=0;i<finSections.length-1;i++)for(let j=0;j<finSteps;j++){
    const a=i*finSteps+j,b=i*finSteps+(j+1)%finSteps,c=a+finSteps,d=b+finSteps;
    finIndices.push(a,c,b,b,c,d);
  }
  const finGeometry=new THREE.BufferGeometry();finGeometry.setAttribute('position',new THREE.Float32BufferAttribute(finVerts,3));finGeometry.setIndex(finIndices);finGeometry.computeVertexNormals();
  mesh(finGeometry,materials.teal,'Vertical_stabilizer');
  line('Fin_leading_edge',finSections.map(s=>[s[1],s[0],0]),materials.silver,.033);
  for(const side of [-1,1])line(`Rudder_hinge_${side}`,finSections.slice(1).map(s=>[s[1]+(s[2]-s[1])*.76,s[0],side*s[3]*.87]),materials.seam,.012);

  // Hollow nacelles. Each has an actual intake throat, 24 swept fan blades and an exhaust.
  const fans=[];
  function revolveX(name,profile,material,parent){
    const p=[],idx=[],n=80;
    for(const [x,r] of profile)for(let j=0;j<=n;j++){
      const a=j/n*Math.PI*2;p.push(x,r*Math.cos(a),r*Math.sin(a));
    }
    for(let i=0;i<profile.length-1;i++)for(let j=0;j<n;j++){
      const a=i*(n+1)+j,b=a+n+1;idx.push(a,a+1,b,a+1,b+1,b);
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(idx);g.computeVertexNormals();
    material.side=THREE.DoubleSide;
    return mesh(g,material,name,parent);
  }
  for(const side of [-1,1]){
    const engine=new THREE.Group();engine.name=`Engine_${side}`;engine.position.set(-3.8,2.04,side*5.5);aircraft.add(engine);
    revolveX('Nacelle_outer',[[-2.02,1.09],[-1.88,1.2],[-1.5,1.25],[-.8,1.25],[.25,1.19],[1.1,1.05],[1.65,.78]],materials.white,engine);
    revolveX('Intake_metal_lip',[[-1.68,1.245],[-1.94,1.18],[-2.05,1.09],[-2.035,1.02],[-1.88,.995],[-1.67,1.005]],materials.silver,engine);
    revolveX('Intake_throat',[[-1.88,1.003],[-1.55,1.002],[-.98,.96]],materials.dark,engine);
    revolveX('Rear_nozzle',[[.9,.88],[1.6,.77],[1.89,.60],[1.89,.51],[1.2,.54]],materials.fan,engine);
    ellipsoid('Exhaust_cone',[1.45,0,0],[.98,.39,.39],materials.dark,engine);
    const fan=new THREE.Group();fan.name=`Fan_${side===1?'R':'L'}`;fan.position.x=-1.01;engine.add(fan);fans.push(fan);
    const disk=mesh(new THREE.CylinderGeometry(.975,.975,.08,64),materials.dark,'Fan_backplate',fan);disk.rotation.z=Math.PI/2;disk.position.x=.19;
    for(let k=0;k<24;k++){
      const vertices=[];
      for(let j=0;j<=8;j++){
        const t=j/8,r=.18+.78*t;
        for(const edge of [0,1]){
          const a=k/24*Math.PI*2 + .37*t*t + edge*(.19-.065*t);
          vertices.push(-.07 + .10*t + edge*.06,r*Math.cos(a),r*Math.sin(a));
        }
      }
      const ids=[];for(let j=0;j<8;j++)ids.push(2*j,2*j+1,2*j+2,2*j+1,2*j+3,2*j+2);
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(ids);g.computeVertexNormals();
      materials.fan.side=THREE.DoubleSide;mesh(g,materials.fan,`Fan_blade_${k}`,fan);
    }
    ellipsoid('Spinner',[-.12,0,0],[.34,.23,.23],materials.fan,fan);
    line('Spinner_spiral',Array.from({length:32},(_,i)=>{
      const t=i/31,a=t*Math.PI*3,r=.018+t*.105;return[-.447+t*.047,r*Math.cos(a),r*Math.sin(a)];
    }),materials.white,.009,fan);
    for(const x of [-1.30,.68]){
      const r=x<0?1.257:1.13;
      line(`Nacelle_panel_${x}`,Array.from({length:65},(_,i)=>[x,r*Math.cos(i/64*Math.PI*2),r*Math.sin(i/64*Math.PI*2)]),materials.seam,.007,engine);
    }
    // Streamlined pylon reaches the underside of the swept wing.
    const pylon=mesh(new THREE.BoxGeometry(2.5,.85,.23),materials.wing,'Engine_pylon');
    pylon.position.set(-2.4,3.2,side*5.5);pylon.rotation.z=.18;
    ellipsoid('Pylon_fairing',[-2.12,3.19,side*5.5],[1.76,.24,.20],materials.wing);
  }

  const gear=new THREE.Group();gear.name='Landing_gear';aircraft.add(gear);
  function wheel(name,x,y,z,r,width){
    // Wheel axle points along Z. Rounded tyres are closed toroidal meshes.
    const tyre=mesh(new THREE.TorusGeometry(r*.73,r*.27,12,32),materials.rubber,name,gear);
    tyre.position.set(x,y,z);
    const hub=mesh(new THREE.CylinderGeometry(r*.48,r*.48,width,24),materials.silver,`${name}_hub`,gear);
    hub.rotation.x=Math.PI/2;hub.position.set(x,y,z);
    for(const side of [-1,1]){
      const center=mesh(new THREE.CylinderGeometry(r*.18,r*.18,.015,16),materials.dark,`${name}_axle_cap`,gear);
      center.rotation.x=Math.PI/2;center.position.set(x,y,z+side*(width/2+.009));
      for(let k=0;k<8;k++){
        const a=k/8*Math.PI*2;
        ellipsoid(`${name}_hub_bolt`,[x+Math.cos(a)*r*.31,y+Math.sin(a)*r*.31,z+side*(width/2+.012)],[.018,.018,.012],materials.dark,gear);
      }
    }
  }
  rod('Nose_oleo',[-14.8,2.68,0],[-14.53,.57,0],.086,materials.silver,gear);
  rod('Nose_upper_strut',[-14.8,2.68,0],[-14.66,1.55,0],.14,materials.wing,gear);
  rod('Nose_drag_brace',[-13.6,2.59,0],[-14.58,1.10,0],.064,materials.silver,gear);
  rod('Nose_axle',[-14.53,.46,-.42],[-14.53,.46,.42],.085,materials.silver,gear);
  for(const side of [-1,1]){
    wheel(`Nose_tyre_${side}`,-14.53,.46,side*.30,.46,.23);
    const door=mesh(new THREE.BoxGeometry(.85,.10,.24),materials.white,`Nose_gear_door_${side}`,gear);
    door.position.set(-14.65,2.47,side*.35);door.rotation.x=side*.65;
    rod(`Main_gear_leg_${side}`,[2.6,3.12,side*2.7],[2.82,.68,side*3.08],.13,materials.silver,gear);
    rod(`Main_gear_sleeve_${side}`,[2.6,3.12,side*2.7],[2.73,1.48,side*2.97],.20,materials.wing,gear);
    rod(`Main_gear_brace_${side}`,[.98,2.9,side*2.1],[2.8,1.02,side*3.05],.095,materials.silver,gear);
    rod(`Main_gear_axle_${side}`,[2.82,.66,side*3.08-.58],[2.82,.66,side*3.08+.58],.13,materials.silver,gear);
    for(const dz of [-.42,.42])wheel(`Main_tyre_${side}_${dz}`,2.82,.66,side*3.08+dz,.66,.33);
    const mainDoor=mesh(new THREE.BoxGeometry(.91,1.22,.065),materials.white,`Main_gear_door_${side}`,gear);
    mainDoor.position.set(2.77,1.68,side*3.48);mainDoor.rotation.x=side*.14;
  }
  ellipsoid('Top_beacon',[-1.0,6.17,0],[.115,.075,.09],materials.red);
  ellipsoid('Bottom_beacon',[.6,2.22,0],[.10,.065,.09],materials.red);
  for(const x of [-4.5,8.4]){
    const fin=new THREE.Shape();fin.moveTo(0,0);fin.lineTo(.52,0);fin.lineTo(.39,.42);fin.lineTo(.30,.42);fin.closePath();
    const object=mesh(new THREE.ExtrudeGeometry(fin,{depth:.055,bevelEnabled:false}),materials.white,'Dorsal_antenna');
    object.position.set(x,6.1,-.0275);
  }
  ellipsoid('APU_exhaust',[18.68,4.94,0],[.09,.12,.12],materials.dark);
  aircraft.updateMatrixWorld(true);
  // Rigid engine animation demonstrates that actual animation clips also export.
  const times = [], rotations = [];
  for (let i = 0; i <= 48; i++) {
    times.push(i / 24);
    rotations.push(...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),i/48*Math.PI*8).toArray());
  }
  const clips = [new THREE.AnimationClip('Engine_Fans', 2, fans.map(fan => new THREE.QuaternionKeyframeTrack(`${fan.name}.quaternion`, times, rotations)))];
  for (const object of meshes) {
    if (/Window|Door_|Cockpit_frame|line|panel|hinge|bolt|spiral|beacon|trim/i.test(object.name)) object.castShadow = false;
  }
  return { aircraft, materials, meshes, gear, fans, clips };
}
