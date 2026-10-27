import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { rectToCuboid, meshVoxel, type CuboidFace } from '../../modcrafting-core/src/voxel-mesh.ts'
import { buildAtlas, resolvePalette, tileRectUvGl, type AtlasResult } from '../../modcrafting-core/src/voxel-atlas.ts'
import type { VoxelDsl } from '../../modcrafting-core/src/voxel-dsl.ts'
import { cellAt, expandSymmetry } from './voxel-editor.ts'

export interface VoxelEdit { x: number; y: number; z: number; value: number }
interface VoxelCanvasProps {
  size: [number, number, number]
  grid: Uint8Array
  dsl: VoxelDsl
  symbols: string[]
  tool: 'place' | 'erase' | 'paint'
  symbol: number
  symmetry: string
  layerLock: boolean
  activeLayer: number
  onEdit: (edits: VoxelEdit[]) => void
}

const faceCorners: Record<CuboidFace, Array<[number, number, number, number, number]>> = {
  up: [[0, 1, 0, 0, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1], [1, 1, 0, 1, 0]],
  down: [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [1, 0, 1, 1, 1], [0, 0, 1, 0, 1]],
  east: [[1, 0, 1, 0, 0], [1, 0, 0, 1, 0], [1, 1, 0, 1, 1], [1, 1, 1, 0, 1]],
  west: [[0, 0, 0, 0, 0], [0, 0, 1, 1, 0], [0, 1, 1, 1, 1], [0, 1, 0, 0, 1]],
  south: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 0, 1]],
  north: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [0, 1, 0, 1, 1], [1, 1, 0, 0, 1]]
}
const faceNormal: Record<CuboidFace, [number, number, number]> = {
  up: [0, 1, 0], down: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1]
}

function buildGeometry(grid: Uint8Array, size: [number, number, number], atlas: AtlasResult, mode: 'shaded' | 'material', dsl: VoxelDsl) {
  const { rects } = meshVoxel(grid, size, dsl.optimize.merge)
  const unit = 16 / Math.max(...size)
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
  for (const rect of rects) {
    const cuboid = rectToCuboid(rect, unit)
    const symbol = dsl ? Object.keys(dsl.palette).sort()[cuboid.value - 1] : ''
    const variant = mode === 'material' ? 'all' : cuboid.face === 'up' ? 'top' : cuboid.face === 'down' ? 'bottom' : 'side'
    const tile = atlas.tiles.find(candidate => candidate.key === `${symbol}:${variant}`) ?? atlas.tiles[0]
    const uvRect = tileRectUvGl(tile, atlas.width, atlas.height)
    const [x0, y0, z0] = cuboid.from, [x1, y1, z1] = cuboid.to
    const coordinate = (axis: 0 | 1 | 2, fraction: number) => [x0, y0, z0][axis] + fraction * ([x1, y1, z1][axis] - [x0, y0, z0][axis])
    const base = positions.length / 3
    const normal = faceNormal[cuboid.face]
    for (const [fx, fy, fz, fu, fv] of faceCorners[cuboid.face]) {
      positions.push(coordinate(0, fx), coordinate(1, fy), coordinate(2, fz))
      normals.push(...normal)
      uvs.push(uvRect.u0 + fu * (uvRect.u1 - uvRect.u0), uvRect.vBottom + fv * (uvRect.vTop - uvRect.vBottom))
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

export function VoxelCanvas(props: VoxelCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; mesh?: THREE.Mesh; texture?: THREE.DataTexture; geometry?: THREE.BufferGeometry; highlight: THREE.LineSegments; floor: THREE.Mesh; raycaster: THREE.Raycaster } | undefined>(undefined)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const container = containerRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth || 640, container.clientHeight || 420)
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x10151a)
    const camera = new THREE.PerspectiveCamera(50, (container.clientWidth || 640) / (container.clientHeight || 420), 0.1, 500)
    camera.position.set(26, 22, 26)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a58, 1.15))
    const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(1.4, 2, 1.1); scene.add(sun)
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(16, 16, 16)), new THREE.LineBasicMaterial({ color: 0x5a7a94 }))
    frame.position.set(0, 0, 0); scene.add(frame)
    const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffe08a }))
    highlight.visible = false; scene.add(highlight)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }))
    floor.rotation.x = -Math.PI / 2; floor.position.y = -8; scene.add(floor)
    const raycaster = new THREE.Raycaster()
    sceneRef.current = { renderer, scene, camera, controls, highlight, floor, raycaster }
    let active = true
    const tick = () => { if (!active) return; controls.update(); sceneRef.current!.renderer.render(scene, camera); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const resize = () => { const width = container.clientWidth, height = container.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix() }
    const observer = new ResizeObserver(resize); observer.observe(container)
    return () => { active = false; observer.disconnect(); controls.dispose(); renderer.dispose(); container.removeChild(renderer.domElement) }
  }, [])

  useEffect(() => {
    const state = sceneRef.current!
    const { grid, size, dsl } = props
    const atlas = buildAtlas(resolvePalette(dsl.palette), dsl.texture.mode)
    if (state.texture) state.texture.dispose()
    const texture = new THREE.DataTexture(atlas.pixels, atlas.width, atlas.height, THREE.RGBAFormat)
    texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true
    if (state.geometry) state.geometry.dispose()
    const geometry = buildGeometry(grid, size, atlas, dsl.texture.mode, dsl)
    if (state.mesh) { state.scene.remove(state.mesh) }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: texture }))
    mesh.position.set(-8, -8, -8)
    state.scene.add(mesh)
    state.mesh = mesh; state.texture = texture; state.geometry = geometry
  }, [props.grid, props.size, props.dsl])

  useEffect(() => {
    const state = sceneRef.current!
    const element = state.renderer.domElement
    const pointer = new THREE.Vector2()
    let downAt: { x: number; y: number } | null = null

    const pick = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect()
      pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1)
      state.raycaster.setFromCamera(pointer, state.camera)
      const targets: THREE.Object3D[] = state.mesh ? [state.mesh, state.floor] : [state.floor]
      const [hit] = state.raycaster.intersectObjects(targets, false)
      return hit
    }

    const targetOf = (hit: THREE.Intersection) => {
      const { size, dsl } = propsRef.current
      const unit = 16 / Math.max(...size)
      const normal = hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0)
      const model = hit.point.clone().sub(new THREE.Vector3(-8, -8, -8))
      const center = model.clone().addScaledVector(normal, -unit / 2)
      const cell = new THREE.Vector3(Math.floor(center.x / unit), Math.floor(center.y / unit), Math.floor(center.z / unit))
      const inBounds = (v: THREE.Vector3) => v.x >= 0 && v.y >= 0 && v.z >= 0 && v.x < size[0] && v.y < size[1] && v.z < size[2]
      const place = model.clone().addScaledVector(normal, unit / 2)
      const placeCell = new THREE.Vector3(Math.floor(place.x / unit), Math.floor(place.y / unit), Math.floor(place.z / unit))
      const hitFloor = hit.object === state.floor
      return { cell, placeCell, normal, inBounds, hitFloor }
    }

    const apply = (hit: THREE.Intersection) => {
      const state = propsRef.current
      const { cell, placeCell, normal, inBounds, hitFloor } = targetOf(hit)
      const tool = state.tool
      if (tool === 'place') {
        if (!inBounds(placeCell) || state.grid[cellAt(state.size, placeCell.x, placeCell.y, placeCell.z)] > 0) return
        const edits: VoxelEdit[] = []
        for (const [mx, mz] of expandSymmetry(state.size, placeCell.x, placeCell.z, state.symmetry)) {
          if (state.layerLock && placeCell.y !== state.activeLayer) return
          edits.push({ x: mx, y: placeCell.y, z: mz, value: state.symbol })
        }
        state.onEdit(edits); return
      }
      if (!inBounds(cell) || hitFloor) return
      const current = state.grid[cellAt(state.size, cell.x, cell.y, cell.z)]
      if (tool === 'erase' && current > 0) {
        const edits: VoxelEdit[] = []
        for (const [mx, mz] of expandSymmetry(state.size, cell.x, cell.z, state.symmetry)) {
          if (state.layerLock && cell.y !== state.activeLayer) return
          edits.push({ x: mx, y: cell.y, z: mz, value: 0 })
        }
        state.onEdit(edits); return
      }
      if (tool === 'paint' && current > 0 && current !== state.symbol) {
        const edits: VoxelEdit[] = []
        for (const [mx, mz] of expandSymmetry(state.size, cell.x, cell.z, state.symmetry)) {
          if (state.layerLock && cell.y !== state.activeLayer) return
          edits.push({ x: mx, y: cell.y, z: mz, value: state.symbol })
        }
        state.onEdit(edits)
      }
    }

    const onDown = (event: PointerEvent) => { if (event.button === 0) downAt = { x: event.clientX, y: event.clientY } }
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || !downAt) return
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
      downAt = null
      if (moved > 6) return
      const hit = pick(event)
      if (hit) apply(hit)
    }
    const onMove = (event: PointerEvent) => {
      const hit = pick(event)
      if (!hit) { state.highlight.visible = false; return }
      const { cell, placeCell, inBounds, hitFloor } = targetOf(hit)
      const current = propsRef.current
      const unit = 16 / Math.max(...current.size)
      const show = current.tool === 'place' ? inBounds(placeCell) && current.grid[cellAt(current.size, placeCell.x, placeCell.y, placeCell.z)] === 0 : !hitFloor && inBounds(cell)
      state.highlight.visible = show
      if (show) {
        const target = current.tool === 'place' ? placeCell : cell
        state.highlight.position.set(target.x * unit - 8 + unit / 2, target.y * unit - 8 + unit / 2, target.z * unit - 8 + unit / 2)
        state.highlight.scale.set(unit, unit, unit)
      }
    }
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerleave', () => { state.highlight.visible = false })
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointermove', onMove)
    }
  }, [])

  return <div ref={containerRef} className="voxel-canvas" aria-label="体素模型 3D 画布" />
}
