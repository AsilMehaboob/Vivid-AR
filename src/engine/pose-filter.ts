import { Quaternion, Vector3 } from "three";

// Adaptive pose smoothing (One-Euro filter, Casiez et al. 2012).
//
// The cutoff frequency rises with speed: when the phone is still, heavy
// smoothing removes tracking noise; when it moves, smoothing drops so the
// overlay doesn't lag behind the print. Position and rotation are filtered
// separately and properly (rotation via slerp), unlike MindAR's built-in filter
// which smooths the 16 raw matrix numbers and can skew the pose.
//
// Units: position in target widths, time in seconds, rotation in radians.

const alpha = (cutoffHz: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export interface PoseFilterParams {
  minCutoff: number;
  beta: number;
  rotMinCutoff: number;
  rotBeta: number;
  /** Cutoff for the speed estimate itself. */
  dCutoff?: number;
}

export class PoseFilter {
  readonly position = new Vector3();
  readonly rotation = new Quaternion();
  private velocity = new Vector3();
  private angularSpeed = 0;
  private lastT = 0;
  private initialized = false;
  private readonly tmpV = new Vector3();
  private readonly tmpQ = new Quaternion();

  constructor(private params: PoseFilterParams) {}

  reset() {
    this.initialized = false;
  }

  /** Feed a raw pose sample taken at time `t` (seconds). */
  update(t: number, position: Vector3, rotation: Quaternion) {
    if (!this.initialized) {
      this.position.copy(position);
      this.rotation.copy(rotation);
      this.velocity.set(0, 0, 0);
      this.angularSpeed = 0;
      this.lastT = t;
      this.initialized = true;
      return;
    }
    // Guard against duplicate or out-of-order timestamps and long stalls.
    const dt = Math.min(Math.max(t - this.lastT, 1 / 240), 0.25);
    this.lastT = t;
    const { minCutoff, beta, rotMinCutoff, rotBeta, dCutoff = 1.0 } = this.params;
    const aD = alpha(dCutoff, dt);

    // Position
    this.tmpV.copy(position).sub(this.position).divideScalar(dt);
    this.velocity.lerp(this.tmpV, aD);
    const aP = alpha(minCutoff + beta * this.velocity.length(), dt);
    this.position.lerp(position, aP);

    // Rotation
    this.tmpQ.copy(this.rotation);
    if (this.tmpQ.dot(rotation) < 0) rotation = rotation.clone().set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
    const angle = this.tmpQ.angleTo(rotation);
    this.angularSpeed += (angle / dt - this.angularSpeed) * aD;
    const aR = alpha(rotMinCutoff + rotBeta * this.angularSpeed, dt);
    this.rotation.slerp(rotation, aR);
  }
}
