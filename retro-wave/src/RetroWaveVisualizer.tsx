import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'

type AudioMode = 'mic' | 'tab'

type AudioBands = {
  bass: number
  mid: number
  treble: number
}

type RidgeLayer = {
  z: number
  baseY: number
  fill: string
  stroke: string
  valleyHalf: number
  ridgeHeight: number
  motion: number
  leftShape: THREE.Shape
  rightShape: THREE.Shape
}

const EMPTY_BANDS: AudioBands = { bass: 0, mid: 0, treble: 0 }

function pseudoRandom(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453123
  return x - Math.floor(x)
}

function createRidgeShape(side: 'left' | 'right', seed: number, baseY: number, valleyHalf: number, height: number) {
  const outerX = side === 'left' ? -14 : 14
  const valleyX = side === 'left' ? -valleyHalf : valleyHalf
  const shape = new THREE.Shape()
  const points = 10

  shape.moveTo(outerX, -4.8)
  shape.lineTo(outerX, baseY + 0.2)

  for (let i = 0; i <= points; i += 1) {
    const t = i / points
    const x = THREE.MathUtils.lerp(outerX, valleyX, t)
    const ridgeFalloff = Math.pow(1 - t, 0.8)
    const noise = 0.58 + pseudoRandom(seed + i * 17.1) * 0.9
    const y = baseY + height * noise * ridgeFalloff
    shape.lineTo(x, y)
  }

  shape.lineTo(valleyX, -4.8)
  shape.closePath()
  return shape
}

function useAudioBands(mode: AudioMode, enabled: boolean) {
  const bands = useRef<AudioBands>({ ...EMPTY_BANDS })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      bands.current = { ...EMPTY_BANDS }
      return
    }

    const audioContext = new AudioContext()
    let stream: MediaStream | undefined
    let animationFrameId = 0
    let cancelled = false

    const init = async () => {
      try {
        if (mode === 'tab') {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        }

        if (cancelled) return

        setError(null)
        await audioContext.resume()

        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.82
        source.connect(analyser)

        const frequencyBuffer = new Uint8Array(analyser.frequencyBinCount)

        const averageBand = (start: number, end: number) => {
          let sum = 0
          let count = 0
          for (let i = start; i <= end && i < frequencyBuffer.length; i += 1) {
            sum += frequencyBuffer[i]
            count += 1
          }
          return count > 0 ? sum / (count * 255) : 0
        }

        const tick = () => {
          analyser.getByteFrequencyData(frequencyBuffer)

          const bass = averageBand(0, 14)
          const mid = averageBand(18, 70)
          const treble = averageBand(90, 180)

          bands.current.bass = THREE.MathUtils.lerp(bands.current.bass, bass, 0.2)
          bands.current.mid = THREE.MathUtils.lerp(bands.current.mid, mid, 0.2)
          bands.current.treble = THREE.MathUtils.lerp(bands.current.treble, treble, 0.2)

          animationFrameId = requestAnimationFrame(tick)
        }

        tick()
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : 'Audio capture failed.')
      }
    }

    void init()

    return () => {
      cancelled = true
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      stream?.getTracks().forEach((track) => track.stop())
      void audioContext.close()
    }
  }, [mode, enabled])

  return { bands, error }
}

function CameraDrift({ bands }: { bands: MutableRefObject<AudioBands> }) {
  const targetPosition = useRef(new THREE.Vector3(0, 3, 8))
  const lookTarget = useRef(new THREE.Vector3(0, 0.9, -11))

  useFrame(({ camera, clock }) => {
    const t = clock.getElapsedTime()
    const bass = bands.current.bass
    const treble = bands.current.treble

    targetPosition.current.set(
      Math.sin(t * 0.18) * 0.35 + treble * 0.22,
      3 + Math.sin(t * 0.36) * 0.12 + bass * 0.08,
      8 + Math.sin(t * 0.25) * 0.2
    )

    lookTarget.current.set(Math.sin(t * 0.12) * 0.45, 0.9 + bass * 0.05, -11)

    camera.position.lerp(targetPosition.current, 0.05)
    camera.lookAt(lookTarget.current)
  })

  return null
}

function Backdrop() {
  const material = useRef<THREE.ShaderMaterial>(null)

  useFrame(({ clock }) => {
    if (!material.current) return
    material.current.uniforms.time.value = clock.getElapsedTime()
  })

  return (
    <mesh position={[0, 2.1, -22]}>
      <planeGeometry args={[48, 28]} />
      <shaderMaterial
        ref={material}
        uniforms={{ time: { value: 0 } }}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec2 vUv;
          uniform float time;

          void main() {
            vec3 top = vec3(0.04, 0.01, 0.14);
            vec3 mid = vec3(0.23, 0.03, 0.33);
            vec3 bottom = vec3(0.96, 0.38, 0.28);
            vec3 gradA = mix(bottom, mid, smoothstep(0.0, 0.55, vUv.y));
            vec3 gradB = mix(mid, top, smoothstep(0.48, 1.0, vUv.y));
            vec3 color = mix(gradA, gradB, smoothstep(0.3, 0.9, vUv.y));
            float haze = sin((vUv.y + time * 0.05) * 42.0) * 0.015 + 0.985;
            gl_FragColor = vec4(color * haze, 1.0);
          }
        `}
      />
    </mesh>
  )
}

function SettingSun({ bands }: { bands: MutableRefObject<AudioBands> }) {
  const material = useRef<THREE.ShaderMaterial>(null)

  useFrame(() => {
    if (!material.current) return
    material.current.uniforms.bass.value = bands.current.bass
  })

  return (
    <mesh position={[0, 1.18, -14]} scale={[1.85, 1.22, 1]}>
      <circleGeometry args={[1.9, 96]} />
      <shaderMaterial
        ref={material}
        transparent
        uniforms={{ bass: { value: 0 } }}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec2 vUv;
          uniform float bass;

          void main() {
            float distCenter = distance(vUv, vec2(0.5));
            if (distCenter > 0.5) discard;

            float lowerHalf = step(vUv.y, 0.52);
            float stripePhase = (1.0 - vUv.y) * 18.0 + bass * 2.4;
            float slices = step(0.42, fract(stripePhase));
            float slicedSun = mix(1.0, slices, lowerHalf);

            vec3 topColor = vec3(1.0, 0.79, 0.32);
            vec3 lowColor = vec3(1.0, 0.34, 0.58);
            vec3 sunColor = mix(lowColor, topColor, smoothstep(0.08, 0.95, vUv.y));

            float glow = smoothstep(0.52, 0.07, distCenter);
            gl_FragColor = vec4(sunColor * slicedSun * glow, 1.0);
          }
        `}
      />
    </mesh>
  )
}

function ValleyGrid({ bands }: { bands: MutableRefObject<AudioBands> }) {
  const material = useRef<THREE.ShaderMaterial>(null)

  useFrame((_, delta) => {
    if (!material.current) return
    material.current.uniforms.time.value += delta
    material.current.uniforms.bass.value = bands.current.bass
    material.current.uniforms.treble.value = bands.current.treble
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.02, -1]}>
      <planeGeometry args={[36, 34, 96, 72]} />
      <shaderMaterial
        ref={material}
        uniforms={{ time: { value: 0 }, bass: { value: 0 }, treble: { value: 0 } }}
        vertexShader={`
          uniform float time;
          uniform float bass;
          varying vec2 vUv;
          varying float vPath;

          void main() {
            vUv = uv;
            vec3 p = position;

            float sideRise = smoothstep(0.8, 1.0, abs(uv.x - 0.5) * 2.0);
            p.y += sideRise * 1.25;
            p.y += sin((p.z + time * 7.0) * 0.45) * bass * 0.45;

            vPath = 1.0 - smoothstep(0.08, 0.42, abs(uv.x - 0.5));
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `}
        fragmentShader={`
          varying vec2 vUv;
          varying float vPath;
          uniform float treble;

          void main() {
            vec2 gridUv = vUv * vec2(28.0, 36.0);
            vec2 grid = abs(fract(gridUv - 0.5) - 0.5) / fwidth(gridUv);
            float line = 1.0 - min(min(grid.x, grid.y), 1.0);

            float depthFade = smoothstep(1.0, 0.12, vUv.y);
            float path = vPath * pow(vUv.y, 1.7);
            float pulse = 0.75 + treble * 0.8;

            vec3 gridColor = vec3(0.48, 0.08, 0.95) * line * depthFade * pulse;
            vec3 pathColor = vec3(1.0, 0.2, 0.56) * path * depthFade;
            vec3 baseColor = vec3(0.04, 0.01, 0.09) * (0.4 + depthFade * 0.5);

            gl_FragColor = vec4(baseColor + gridColor + pathColor, 1.0);
          }
        `}
      />
    </mesh>
  )
}

function ValleyRanges({ bands }: { bands: MutableRefObject<AudioBands> }) {
  const leftRefs = useRef<Array<THREE.Group | null>>([])
  const rightRefs = useRef<Array<THREE.Group | null>>([])

  const layers = useMemo<RidgeLayer[]>(
    () =>
      Array.from({ length: 5 }).map((_, index) => {
        const depth = index / 4
        const z = -8.5 - index * 1.45
        const valleyHalf = 3.4 - depth * 2.15
        const baseY = -1.26 + depth * 0.42
        const ridgeHeight = 2.45 - depth * 0.92
        const colorMix = 0.2 + depth * 0.65
        const fill = new THREE.Color().setRGB(0.04 + colorMix * 0.15, 0.02, 0.14 + colorMix * 0.16).getStyle()
        const stroke = new THREE.Color().setRGB(0.1 + colorMix * 0.2, 0.5 + colorMix * 0.3, 0.95).getStyle()

        return {
          z,
          baseY,
          fill,
          stroke,
          valleyHalf,
          ridgeHeight,
          motion: 0.08 + index * 0.06,
          leftShape: createRidgeShape('left', 30 + index * 12.3, baseY, valleyHalf, ridgeHeight),
          rightShape: createRidgeShape('right', 70 + index * 13.7, baseY, valleyHalf, ridgeHeight),
        }
      }),
    []
  )

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const pulse = bands.current.mid

    layers.forEach((layer, index) => {
      const drift = Math.sin(t * (0.34 + layer.motion) + index * 0.62) * layer.motion
      const lift = pulse * layer.motion * 0.65
      const y = drift + lift
      const left = leftRefs.current[index]
      const right = rightRefs.current[index]
      if (left) left.position.y = y
      if (right) right.position.y = y * 0.9
    })
  })

  return (
    <>
      {layers.map((layer, index) => (
        <group key={`left-${index}`} ref={(group) => (leftRefs.current[index] = group)} position={[0, 0, layer.z]}>
          <mesh>
            <shapeGeometry args={[layer.leftShape]} />
            <meshBasicMaterial color={layer.fill} />
          </mesh>
          <mesh position={[0, 0, 0.03]}>
            <shapeGeometry args={[layer.leftShape]} />
            <meshBasicMaterial color={layer.stroke} wireframe transparent opacity={0.72} />
          </mesh>
        </group>
      ))}
      {layers.map((layer, index) => (
        <group
          key={`right-${index}`}
          ref={(group) => (rightRefs.current[index] = group)}
          position={[0, 0, layer.z]}
        >
          <mesh>
            <shapeGeometry args={[layer.rightShape]} />
            <meshBasicMaterial color={layer.fill} />
          </mesh>
          <mesh position={[0, 0, 0.03]}>
            <shapeGeometry args={[layer.rightShape]} />
            <meshBasicMaterial color={layer.stroke} wireframe transparent opacity={0.72} />
          </mesh>
        </group>
      ))}
    </>
  )
}

function ScanLines() {
  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        inset: 0,
        background:
          'repeating-linear-gradient(to bottom, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 1px, transparent 3px, transparent 5px)',
        opacity: 0.12,
      }}
    />
  )
}

export default function RetroWaveVisualizer() {
  const [mode, setMode] = useState<AudioMode>('tab')
  const [enabled, setEnabled] = useState(false)
  const { bands, error } = useAudioBands(mode, enabled)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          border: '1px solid rgba(255, 0, 153, 0.45)',
          borderRadius: 10,
          background: 'rgba(10, 0, 36, 0.66)',
          backdropFilter: 'blur(4px)',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setMode('tab')}>
            Tab Audio
          </button>
          <button type="button" onClick={() => setMode('mic')}>
            Microphone
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setEnabled(true)}>
            Connect
          </button>
          <button type="button" onClick={() => setEnabled(false)}>
            Stop
          </button>
        </div>
        <small style={{ maxWidth: 300, opacity: 0.92 }}>
          For tab audio, choose the browser tab and enable the share-audio checkbox in the browser picker.
        </small>
        {error ? <small style={{ color: '#ff808f' }}>{error}</small> : null}
      </div>

      <Canvas camera={{ position: [0, 3, 8], fov: 60 }}>
        <color attach="background" args={['#050014']} />
        <fog attach="fog" args={['#060017', 9, 25]} />
        <CameraDrift bands={bands} />
        <Backdrop />
        <SettingSun bands={bands} />
        <ValleyRanges bands={bands} />
        <ValleyGrid bands={bands} />
        <EffectComposer>
          <Bloom intensity={1.2} luminanceThreshold={0.18} />
        </EffectComposer>
      </Canvas>
      <ScanLines />
    </div>
  )
}
