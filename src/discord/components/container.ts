// the container is the only top-level v2 layout component. it holds no state,
// just children and an accent colour (D4PLAN 9.1).

import { ComponentTypes, type ContainerComponent } from "oceanic.js";

// components v2 must carry this message flag or discord rejects the payload, and
// once set it cannot be removed. exported so nothing sends a v2 message without
// it. verified against the milestone 0 spike, not re-derived (D4PLAN 9).
export const IS_COMPONENTS_V2 = 32768;

export type ContainerChild = ContainerComponent["components"][number];

export interface ContainerOptions {
  accent?: number;
  children: ContainerChild[];
  spoiler?: boolean;
}

export function container(opts: ContainerOptions): ContainerComponent {
  const { accent, children, spoiler } = opts;
  if (accent !== undefined && (accent < 0x000000 || accent > 0xffffff)) {
    throw new Error(`container: accent 0x${accent.toString(16)} is outside 0x000000-0xFFFFFF`);
  }
  for (const child of children) {
    // containers never nest inside containers. the type already excludes it, so
    // narrow through number to keep the runtime guard honest.
    if ((child as { type: number }).type === ComponentTypes.CONTAINER) {
      throw new Error("container: containers cannot nest");
    }
  }
  return { type: ComponentTypes.CONTAINER, accentColor: accent, components: children, spoiler };
}

// binds a container to the v2 flag so the caller cannot forget it on a message.
export function v2Message(build: ContainerComponent): {
  flags: number;
  components: ContainerComponent[];
} {
  return { flags: IS_COMPONENTS_V2, components: [build] };
}
