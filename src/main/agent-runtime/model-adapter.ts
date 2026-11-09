import type { RuntimeModel } from './contracts'

/** Converts the engine-neutral Navo model DTO into an engine-specific model and stream function. */
export interface ModelAdapter<TModel, TStream = unknown> {
  model(config: RuntimeModel): TModel
  stream(config: RuntimeModel): TStream
}
