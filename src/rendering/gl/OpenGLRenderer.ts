// src/rendering/gl/OpenGLRenderer.ts
import { mat4, vec4 } from "gl-matrix";
import Drawable from "./Drawable";
import Camera from "../../Camera";
import { gl } from "../../globals";
import ShaderProgram from "./ShaderProgram";

type RenderUniforms = {
  time?: number;
  color?: vec4;
};

function isVec4(x: any): x is vec4 {
  return x instanceof Float32Array && x.length === 4;
}

class OpenGLRenderer {
  constructor(public canvas: HTMLCanvasElement) {}

  setClearColor(r: number, g: number, b: number, a: number) {
    gl.clearColor(r, g, b, a);
  }

  setSize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  clear() {
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  render(
    camera: Camera,
    prog: ShaderProgram,
    drawables: Array<Drawable>,
    uniforms?: vec4 | RenderUniforms
  ) {
    // Normalize uniforms arg
    let time: number | undefined;
    let color: vec4 | undefined;
    if (uniforms) {
      if (isVec4(uniforms)) color = uniforms;
      else { time = uniforms.time; color = uniforms.color; }
    }

    // Build MVP (hw0 path)
    const model = mat4.create();
    const viewProj = mat4.create();
    mat4.identity(model);
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);

    // Ensure the program is in use
    gl.useProgram(prog.prog);

    // 1) Try helper methods if they exist
    if ((prog as any).setModelMatrix) (prog as any).setModelMatrix(model);
    if ((prog as any).setViewProjMatrix) (prog as any).setViewProjMatrix(viewProj);
    if ((prog as any).setEyeRefUp) {
      const c: any = (camera as any).controls;
      if (c?.eye && c?.center && c?.up) (prog as any).setEyeRefUp(c.eye, c.center, c.up);
    }
    if (time !== undefined && (prog as any).setTime) (prog as any).setTime(time);
    if (color && (prog as any).setGeometryColor) (prog as any).setGeometryColor(color);

    // 2) Always also set by raw uniform names (fallback)
    const uModelLoc    = gl.getUniformLocation(prog.prog, "u_Model");
    const uViewProjLoc = gl.getUniformLocation(prog.prog, "u_ViewProj");
    const uTimeLoc     = gl.getUniformLocation(prog.prog, "u_Time");
    const uColorLoc    = gl.getUniformLocation(prog.prog, "u_Color");

    if (uModelLoc)    gl.uniformMatrix4fv(uModelLoc, false, model);
    if (uViewProjLoc) gl.uniformMatrix4fv(uViewProjLoc, false, viewProj);
    if (uTimeLoc !== null && time !== undefined) gl.uniform1f(uTimeLoc, time);
    if (uColorLoc && color) gl.uniform4fv(uColorLoc, color);

    // Draw
    for (const d of drawables) {
      prog.draw(d);
    }
  }
}

export default OpenGLRenderer;