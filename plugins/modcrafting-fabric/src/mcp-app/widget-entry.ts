import { connectWidget } from './bridge.ts'
import { render } from './widget.ts'

connectWidget(render)
