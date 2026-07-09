import React from 'react'
import BlockIcon from './BlockIcon'
import { BlockTextures } from '../data/items'

interface BlockIcon3DProps {
  textures: BlockTextures
  size?: number
  className?: string
}

/** @deprecated Use BlockIcon instead */
const BlockIcon3D: React.FC<BlockIcon3DProps> = (props) => <BlockIcon {...props} shape="cube" />

export default BlockIcon3D
