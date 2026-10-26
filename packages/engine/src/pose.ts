import type { Shot } from '@shortstudio/schema';
import { faceStateAt, gestureWeight, headLagWeight, type FaceState } from './rules';
import { rigAt, type RigState } from './rig';

export interface ArmPose {
  /** 0..1 raise (arm up and out) */
  raise: number;
  /** 0..1 point (arm forward) */
  point: number;
}

export interface ActorPose {
  left: ArmPose;
  right: ArmPose;
  /** Head pitch weight, trails the hand by HEAD_LAG_FRAMES. */
  headNod: number;
  face: FaceState;
  /** Where the body is and how its legs move: root path, walk cycle, jolt (see rig.ts). */
  rig: RigState;
}

/**
 * Pure pose for one actor at timeline time `t`. With no events active every
 * value is a constant, so idle is dead still by construction (rule 1).
 */
export function actorPoseAt(shot: Shot, actorId: string, t: number): ActorPose {
  const actor = shot.actors.find((a) => a.id === actorId)!;
  const pose: ActorPose = {
    left: { raise: 0, point: 0 },
    right: { raise: 0, point: 0 },
    headNod: 0,
    face: 'neutral',
    rig: rigAt(shot, actor, t),
  };
  const cues: { at: number; expression: 'neutral' | 'panic' | 'happy' }[] = [];
  for (const e of shot.events) {
    if (e.actor !== actorId) continue;
    if (e.type === 'expression') {
      cues.push({ at: e.at, expression: e.expression });
    } else if (e.type === 'gesture') {
      const w = gestureWeight(t, e.at, { hold: e.hold });
      const arm = pose[e.hand];
      arm[e.gesture] = Math.max(arm[e.gesture], w);
      pose.headNod = Math.max(pose.headNod, headLagWeight(t, e.at, { hold: e.hold }));
    }
  }
  pose.face = faceStateAt(cues, t);
  return pose;
}
