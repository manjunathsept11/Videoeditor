import { z } from 'zod';

/** All timing rules are authored at this rate; JSON stores seconds, never frames. */
export const CANONICAL_FPS = 30;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Vec2 = z.tuple([z.number(), z.number()]);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');
const Id = z.string().regex(/^[a-z0-9_]+$/, 'ids are lowercase a-z, 0-9, _');

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

export const ActorEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('gesture'),
    actor: Id,
    /** Time of the spoken word this gesture belongs to (seconds, project timeline). */
    at: z.number(),
    gesture: GestureKind,
    hand: z.enum(['left', 'right']).default('right'),
    hold: z.number().default(0.8),
  }),
  z.object({
    type: z.literal('expression'),
    actor: Id,
    at: z.number(),
    expression: ExpressionId,
  }),
]);

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

export const Shot = z.object({
  id: Id,
  set: Id,
  /** Absolute start on the project timeline, seconds. */
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  camera: Camera,
  actors: z.array(Actor).default([]),
  events: z.array(ActorEvent).default([]),
  transitionIn: Transition.default({ type: 'cut', frames: 6 }),
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
});

export type Project = z.infer<typeof Project>;
export type SetDef = z.infer<typeof SetDef>;
export type SetObject = z.infer<typeof SetObject>;
export type Shot = z.infer<typeof Shot>;
export type Actor = z.infer<typeof Actor>;
export type ActorEvent = z.infer<typeof ActorEvent>;
export type Camera = z.infer<typeof Camera>;
export type ExpressionId = z.infer<typeof ExpressionId>;
export type GestureKind = z.infer<typeof GestureKind>;
export type LightingPreset = z.infer<typeof LightingPreset>;

/** A fully resolved project: what the engine renders. */
export interface Bundle {
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
export function parseBundle(raw: {
  project: unknown;
  sets: unknown[];
  shots: unknown[];
}): Bundle {
  const issues: string[] = [];
  const check = <T>(schema: z.ZodType<T>, value: unknown, label: string): T | undefined => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    for (const i of r.error.issues) issues.push(`${label}: ${i.path.join('.') || '(root)'} ${i.message}`);
    return undefined;
  };

  const project = check(Project, raw.project, 'project.json');
  const sets: Record<string, SetDef> = {};
  const shots: Record<string, Shot> = {};
  raw.sets.forEach((s, i) => {
    const v = check(SetDef, s, `sets[${i}]`);
    if (v) sets[v.id] = v;
  });
  raw.shots.forEach((s, i) => {
    const v = check(Shot, s, `shots[${i}]`);
    if (v) shots[v.id] = v;
  });
  if (!project) throw new BundleError(issues);

  for (const id of project.sets) if (!sets[id]) issues.push(`project lists set "${id}" but no such set was loaded`);
  for (const id of project.shots) if (!shots[id]) issues.push(`project lists shot "${id}" but no such shot was loaded`);
  for (const shot of Object.values(shots)) {
    if (!sets[shot.set]) issues.push(`shot "${shot.id}" uses unknown set "${shot.set}"`);
    const actorIds = new Set(shot.actors.map((a) => a.id));
    for (const e of shot.events) {
      if (!actorIds.has(e.actor)) issues.push(`shot "${shot.id}" event targets unknown actor "${e.actor}"`);
    }
    if (actorIds.size !== shot.actors.length) issues.push(`shot "${shot.id}" has duplicate actor ids`);
  }
  if (issues.length) throw new BundleError(issues);
  return { project, sets, shots };
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
