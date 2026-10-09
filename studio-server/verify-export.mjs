import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Box3} from 'three';
const root=new URL('../.studio/projects/',import.meta.url);
const results=[];
for(const id of await readdir(root)){
  const exportDir=new URL(`${id}/exports/`,root);
  let files;try{files=await readdir(exportDir);}catch{continue;}
  for(const file of files.filter(f=>f.endsWith('.glb'))){
    const bytes=await readFile(new URL(file,exportDir));
    const array=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const gltf=await new GLTFLoader().parseAsync(array,'');
    let meshes=0;gltf.scene.traverse(o=>{if(o.isMesh)meshes++;});
    const box=new Box3().setFromObject(gltf.scene);
    if(!meshes||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))throw new Error('Invalid exported geometry');
    results.push({project:id,file,bytes:bytes.length,meshes,animations:gltf.animations.length});
  }
}
if(!results.length)throw new Error('No saved exports to verify');
console.log(JSON.stringify(results,null,2));
