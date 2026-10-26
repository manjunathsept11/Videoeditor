import { z } from 'zod';
import { resolveShots, type Alignment } from './alignment';

export * from './alignment';

/** All timing rules are authored at this rate; JSON stores seconds, never frames. */
export const CANONICAL_FPS = 30;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Vec2 = z.tuple([z.number(), z.number()]);
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');
export const Id = z.string().regex(/^[a-z0-9_]+$/, 'ids are lowercase a-z, 0-9, _');

export const LightingPreset = z.enum(['cinema', 'clean']);
export const ExpressionId = z.enum(['neutral', 'panic', 'happy']);
export const GestureKind = z.enum(['raise', 'point']);

// ---------------------------------------------------------------- sets

export const SetObject = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('floor'),
    id: Id,
    size: Vec2,
    color: Color,
    position: Vec3.default([0, 0, 0]),
  }),
  z.object({
    kind: z.literal('box'),
    id: Id,
    position: Vec3,
    size: Vec3,
    color: Color,
    emissive: Color.optional(),
    emissiveIntensity: z.number().default(1),
    /** Procedural lit-window grid on the +z face (deterministic from id). */
    windows: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('sign'),
    id: Id,
    position: Vec3,
    size: Vec2,
    text: z.string(),
    color: Color,
    background: Color.default('#0a0a14'),
    rotationY: z.number().default(0),
    glow: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('light'),
    id: Id,
    position: Vec3,
    color: Color,
    intensity: z.number().default(20),
    distance: z.number().default(12),
  }),
]);

export const SetDef = z.object({
  id: Id,
  lighting: LightingPreset.default('cinema'),
  background: Color,
  fog: z.object({ color: Color, near: z.number(), far: z.number() }).optional(),
  objects: z.array(SetObject),
});

// ---------------------------------------------------------------- shots

export const Actor = z.object({
  id: Id,
  bodyColor: Color,
  position: Vec3,
  /** Rotation about Y in radians. 0 faces +z (toward the default camera). */
  facingY: z.number().default(0),
  glasses: z.boolean().default(false),
  scale: z.number().default(1),
});

/**
 * A point on the voiceover, by word instead of by hand-typed seconds.
 * `word` may be a phrase ("the window"); `nth` picks the nth occurrence.
 */
export const Anchor = z.object({
  word: z.string().min(1),
  nth: z.number().int().positive().default(1),
  edge: z.enum(['start', 'end']).default('start'),
  /** Extra seconds added after resolving (usually 0; gesture lead is applied by the engine). */
  offset: z.number().default(0),
});
export const TimeRef = z.union([z.number(), Anchor]);

const makeActorEvent = <T extends z.ZodTypeAny>(time: T) =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('gesture'),
      actor: Id,
      /** Time of the spoken word this gesture belongs to (seconds, project timeline). */
      at: time,
      gesture: GestureKind,
      hand: z.enum(['left', 'right']).default('right'),
      hold: z.number().default(0.8),
    }),
    z.object({
      type: z.literal('expression'),
      actor: Id,
      at: time,
      expression: ExpressionId,
    }),
  ]);
export const ActorEvent = makeActorEvent(z.number());
export const ActorEventSource = makeActorEvent(TimeRef);

// ---------------------------------------------------------------- props

/** Physical number objects: a value shown as a thing in the world, never as a text overlay. */
export const PropDef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('counter'),
    id: Id,
    position: Vec3,
    rotationY: z.number().default(0),
    scale: z.number().default(1),
    digits: z.number().int().min(1).max(10).default(4),
    prefix: z.string().default(''),
    suffix: z.string().default(''),
    initial: z.number().default(0),
  }),
  z.object({
    kind: z.literal('dial'),
    id: Id,
    position: Vec3,
    rotationY: z.number().default(0),
    scale: z.number().default(1),
    min: z.number().default(0),
    max: z.number().default(100),
    initial: z.number().default(0),
    label: z.string().default(''),
  }),
  z.object({
    kind: z.literal('calendar'),
    id: Id,
    position: Vec3,
    rotationY: z.number().default(0),
    scale: z.number().default(1),
    /** Day number shown at the start (1-31). */
    initial: z.number().int().min(1).max(31).default(1),
    month: z.string().default(''),
  }),
  z.object({
    kind: z.literal('clock'),
    id: Id,
    position: Vec3,
    rotationY: z.number().default(0),
    scale: z.number().default(1),
    /** "HH:MM" the hands start on. */
    initial: z.string().regex(/^\d{1,2}:\d{2}$/).default('12:00'),
  }),
  z.object({
    kind: z.literal('magnifier'),
    id: Id,
    position: Vec3,
    rotationY: z.number().default(0),
    scale: z.number().default(1),
    /** Lens start position on the document, in document units (-1..1). */
    initial: Vec2.default([-0.6, 0.4]),
    /** Lines drawn on the document so the lens has something to magnify. */
    text: z.string().default(''),
  }),
]);

const makePropEvent = <T extends z.ZodTypeAny>(time: T) =>
  z.object({
    prop: Id,
    /** The spoken word the value must land on: the prop reaches it on exactly this frame. */
    at: time,
    /** counter / dial / calendar: the value to roll to. */
    value: z.number().optional(),
    /** clock: "HH:MM" to whirl to. */
    time: z
      .string()
      .regex(/^\d{1,2}:\d{2}$/)
      .optional(),
    /** magnifier: where the lens slides to (-1..1). */
    to: Vec2.optional(),
  });
export const PropEvent = makePropEvent(z.number());
export const PropEventSource = makePropEvent(TimeRef);

export const Camera = z.object({
  position: Vec3,
  target: Vec3,
  fov: z.number().default(35),
  /** Fractional zoom per second. Spec: constant 5%/sec, no handheld noise. */
  creep: z.number().default(0.05),
});

export const Transition = z.object({
  type: z.enum(['cut', 'dissolve']).default('cut'),
  frames: z.number().int().positive().default(6),
});

const shotBase = {
  id: Id,
  set: Id,
  camera: Camera,
  actors: z.array(Actor).default([]),
  props: z.array(PropDef).default([]),
  transitionIn: Transition.default({ type: 'cut', frames: 6 }),
};

/** What the engine renders: every time is absolute seconds on the project timeline. */
export const Shot = z.object({
  ...shotBase,
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  events: z.array(ActorEvent).default([]),
  propEvents: z.array(PropEvent).default([]),
});

/**
 * What files on disk contain: times may be word anchors, and `duration` may be
 * omitted (the shot then runs until the next shot starts).
 */
export const ShotSource = z.object({
  ...shotBase,
  start: z.union([z.number().nonnegative(), Anchor]),
  duration: z.number().positive().optional(),
  events: z.array(ActorEventSource).default([]),
  propEvents: z.array(PropEventSource).default([]),
});

// ---------------------------------------------------------------- project

export const Project = z.object({
  version: z.literal(1).default(1),
  name: z.string(),
  width: z.number().int().default(1080),
  height: z.number().int().default(1920),
  /** Export frame rate. Rules still resolve on the 30fps canonical grid. */
  fps: z.union([z.literal(30), z.literal(60)]).default(30),
  sets: z.array(Id),
  shots: z.array(Id),
  /** Word-timed captions in the lower 30%; only drawn when the project has an alignment. */
  captions: z
    .object({
      enabled: z.boolean().default(true),
      maxWords: z.number().int().positive().default(3),
      /** Colour of the word currently being spoken. Omit for plain white. */
      highlight: Color.optional(),
    })
    .default({ enabled: true, maxWords: 3 }),
});

export type Project = z.infer<typeof Project>;
export type SetDef = z.infer<typeof SetDef>;
export type SetObject = z.infer<typeof SetObject>;
export type Shot = z.infer<typeof Shot>;
export type ShotSource = z.infer<typeof ShotSource>;
export type Anchor = z.infer<typeof Anchor>;
export type TimeRef = z.infer<typeof TimeRef>;
export type Actor = z.infer<typeof Actor>;
export type ActorEvent = z.infer<typeof ActorEvent>;
export type Camera = z.infer<typeof Camera>;
export type PropDef = z.infer<typeof PropDef>;
export type PropEvent = z.infer<typeof PropEvent>;
export type ExpressionId = z.infer<typeof ExpressionId>;
export type GestureKind = z.infer<typeof GestureKind>;
export type LightingPreset = z.infer<typeof LightingPreset>;

/** A fully resolved project: what the engine renders. */
export interface Bundle {
  /** Word timings the project was resolved against (drives captions). */
  alignment?: Alignment;
  project: Project;
  sets: Record<string, SetDef>;
  shots: Record<string, Shot>;
}

export class BundleError extends Error {
  constructor(public issues: string[]) {
    super(`Invalid project bundle:\n - ${issues.join('\n - ')}`);
  }
}

/**
 * Validate raw JSON (project.json + sets/*.json + shots/*.json) into a Bundle,
 * including cross-references the per-file schemas cannot check.
 */
export function parseBundle(
  raw: { project: unknown; sets: unknown[]; shots: unknown[] },
  opts: { alignment?: Alignment } = {},
): Bundle {
  const issues: string[] = [];
  const check = <T>(schema: z.ZodType<T>, value: unknown, label: string): T | undefined => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    for (const i of r.error.issues) issues.push(`${label}: ${i.path.join('.') || '(root)'} ${i.message}`);
    return undefined;
  };

  const project = check(Project, raw.project, 'project.json');
  const sets: Record<string, SetDef> = {};
  const sources: Record<string, ShotSource> = {};
  raw.sets.forEach((s, i) => {
    const v = check(SetDef, s, `sets[${i}]`);
    if (v) sets[v.id] = v;
  });
  raw.shots.forEach((s, i) => {
    const v = check(ShotSource, s, `shots[${i}]`);
    if (v) sources[v.id] = v;
  });
  if (!project) throw new BundleError(issues);

  const resolved = resolveShots(sources, project.shots, opts.alignment);
  issues.push(...resolved.issues);
  const shots = resolved.shots;

  for (const id of project.sets) if (!sets[id]) issues.push(`project lists set "${id}" but no such set was loaded`);
  for (const id of project.shots) if (!shots[id]) issues.push(`project lists shot "${id}" but no such shot was loaded`);
  for (const shot of Object.values(shots)) {
    if (!sets[shot.set]) issues.push(`shot "${shot.id}" uses unknown set "${shot.set}"`);
    const actorIds = new Set(shot.actors.map((a) => a.id));
    for (const e of shot.events) {
      if (!actorIds.has(e.actor)) issues.push(`shot "${shot.id}" event targets unknown actor "${e.actor}"`);
    }
    if (actorIds.size !== shot.actors.length) issues.push(`shot "${shot.id}" has duplicate actor ids`);
    const props = new Map(shot.props.map((p) => [p.id, p]));
    if (props.size !== shot.props.length) issues.push(`shot "${shot.id}" has duplicate prop ids`);
    for (const e of shot.propEvents) {
      const p = props.get(e.prop);
      if (!p) {
        issues.push(`shot "${shot.id}" propEvent targets unknown prop "${e.prop}"`);
        continue;
      }
      const need = p.kind === 'clock' ? 'time' : p.kind === 'magnifier' ? 'to' : 'value';
      if (e[need] === undefined) issues.push(`shot "${shot.id}" propEvent for ${p.kind} "${p.id}" needs "${need}"`);
    }
  }
  if (issues.length) throw new BundleError(issues);
  return { project, sets, shots, alignment: opts.alignment };
}

/** Shots in timeline order. */
export function orderedShots(bundle: Bundle): Shot[] {
  return bundle.project.shots
    .map((id) => bundle.shots[id]!)
    .sort((a, b) => a.start - b.start);
}

export function projectDuration(bundle: Bundle): number {
  return orderedShots(bundle).reduce((m, s) => Math.max(m, s.start + s.duration), 0);
}
