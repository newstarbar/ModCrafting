import React from 'react'
import { BlockShape, BlockTextures } from '../data/items'

interface BlockIconProps {
  textures: BlockTextures
  shape?: BlockShape
  size?: number
  className?: string
}

function Face({
  texture,
  transform,
  faceSize,
  fallbackColor,
}: {
  texture: string | null
  transform: string
  faceSize: number
  fallbackColor: string
}) {
  return (
    <div
      style={{
        position: 'absolute',
        width: faceSize,
        height: faceSize,
        backgroundImage: texture ? `url(/${texture})` : undefined,
        backgroundColor: texture ? 'transparent' : fallbackColor,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        imageRendering: 'pixelated',
        transform,
        backfaceVisibility: 'hidden',
      }}
    />
  )
}

function CubeIcon({ textures, size }: { textures: BlockTextures; size: number }) {
  const halfSize = size * 0.4
  const faceSize = halfSize * 2

  return (
    <div
      style={{
        width: faceSize,
        height: faceSize,
        position: 'relative',
        transformStyle: 'preserve-3d',
        transform: 'rotateX(-35.26deg) rotateY(45deg)',
      }}
    >
      <Face
        texture={textures.north}
        faceSize={faceSize}
        transform={`translateZ(${halfSize}px)`}
        fallbackColor="#4a7f4a"
      />
      <Face
        texture={textures.east}
        faceSize={faceSize}
        transform={`rotateY(90deg) translateZ(${halfSize}px)`}
        fallbackColor="#3a6f3a"
      />
      <Face
        texture={textures.top}
        faceSize={faceSize}
        transform={`rotateX(90deg) translateZ(${halfSize}px)`}
        fallbackColor="#5a8f5a"
      />
    </div>
  )
}

function SlabIcon({ textures, size }: { textures: BlockTextures; size: number }) {
  const halfSize = size * 0.4
  const faceSize = halfSize * 2
  const slabH = faceSize * 0.5

  return (
    <div
      style={{
        width: faceSize,
        height: faceSize,
        position: 'relative',
        transformStyle: 'preserve-3d',
        transform: `rotateX(-35.26deg) rotateY(45deg) translateY(${slabH * 0.25}px)`,
      }}
    >
      <Face
        texture={textures.north}
        faceSize={faceSize}
        transform={`translateZ(${halfSize}px) scaleY(0.5) translateY(${slabH * 0.5}px)`}
        fallbackColor="#4a7f4a"
      />
      <Face
        texture={textures.east}
        faceSize={faceSize}
        transform={`rotateY(90deg) translateZ(${halfSize}px) scaleY(0.5) translateY(${slabH * 0.5}px)`}
        fallbackColor="#3a6f3a"
      />
      <Face
        texture={textures.top}
        faceSize={faceSize}
        transform={`rotateX(90deg) translateZ(${slabH}px)`}
        fallbackColor="#5a8f5a"
      />
    </div>
  )
}

function StairsIcon({ textures, size }: { textures: BlockTextures; size: number }) {
  const halfSize = size * 0.4
  const faceSize = halfSize * 2
  const stepH = faceSize * 0.5

  const Step = ({ zOff, yOff }: { zOff: number; yOff: number }) => (
    <div
      style={{
        position: 'absolute',
        width: faceSize,
        height: faceSize,
        transformStyle: 'preserve-3d',
        transform: `translate3d(0, ${yOff}px, ${zOff}px)`,
      }}
    >
      <Face
        texture={textures.north}
        faceSize={faceSize}
        transform={`translateZ(${halfSize}px) scaleY(0.5) translateY(${stepH * 0.5}px)`}
        fallbackColor="#4a7f4a"
      />
      <Face
        texture={textures.east}
        faceSize={faceSize}
        transform={`rotateY(90deg) translateZ(${halfSize}px) scaleY(0.5) translateY(${stepH * 0.5}px)`}
        fallbackColor="#3a6f3a"
      />
      <Face
        texture={textures.top}
        faceSize={faceSize}
        transform={`rotateX(90deg) translateZ(${stepH}px)`}
        fallbackColor="#5a8f5a"
      />
    </div>
  )

  return (
    <div
      style={{
        width: faceSize,
        height: faceSize,
        position: 'relative',
        transformStyle: 'preserve-3d',
        transform: 'rotateX(-35.26deg) rotateY(45deg)',
      }}
    >
      <Step zOff={0} yOff={stepH * 0.25} />
      <Step zOff={-stepH * 0.35} yOff={-stepH * 0.15} />
    </div>
  )
}

const BlockIcon: React.FC<BlockIconProps> = ({
  textures,
  shape = 'cube',
  size = 32,
  className,
}) => {
  const content = (() => {
    switch (shape) {
      case 'slab':
        return <SlabIcon textures={textures} size={size} />
      case 'stairs':
        return <StairsIcon textures={textures} size={size} />
      case 'hopper':
      case 'cube':
      default:
        return <CubeIcon textures={textures} size={size} />
    }
  })()

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        perspective: `${size * 5}px`,
        transformStyle: 'preserve-3d',
        imageRendering: 'pixelated',
        overflow: 'visible',
      }}
    >
      {content}
    </div>
  )
}

export default BlockIcon
