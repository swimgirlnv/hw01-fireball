#version 300 es
precision highp float;
precision highp int;

in vec4 vs_Pos;

// Matrices from renderer / camera
uniform mat4 u_Model;
uniform mat4 u_ViewProj;

// ---------- shared ----------
uniform float u_Time;
uniform int   u_Octaves;

// ---------- core (pass 0) ----------
uniform float u_CoreLowAmp;
uniform float u_CoreHiAmp;
uniform float u_CoreScale;

// ---------- flames / glow (pass 1,2) ----------
uniform float u_FlameNoiseScale;
uniform float u_FlameHiAmp;
uniform float u_FlameLift;
uniform vec3  u_UpDir;

// ---------- mouse deformation ----------
uniform vec2  u_MouseNDC;
uniform float u_MouseStrength;
uniform float u_MouseFalloff;
uniform int   u_MouseOn;

// ---------- extras ----------
uniform float u_ShellOffset;
uniform float u_GlowOffset;
uniform float u_SceneScale;
uniform int   u_Pass;          // 0=core, 1=flames, 2=glow

out vec3  v_Pos;
out float v_Core;
out float v_Height;
out float v_Radial;
out float v_Rim;
out float v_Grain;
out float v_UpDot;

float h31(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.1,0.2,0.3));
  p += dot(p, p.yzx + 19.19);
  return fract(p.x * p.y * p.z * 93.733);
}

float vnoise(vec3 p){
  vec3 i=floor(p), f=fract(p);
  vec3 u=f*f*(3.0-2.0*f);
  float n000=h31(i+vec3(0,0,0)), n100=h31(i+vec3(1,0,0));
  float n010=h31(i+vec3(0,1,0)), n110=h31(i+vec3(1,1,0));
  float n001=h31(i+vec3(0,0,1)), n101=h31(i+vec3(1,0,1));
  float n011=h31(i+vec3(0,1,1)), n111=h31(i+vec3(1,1,1));
  float nx00=mix(n000,n100,u.x), nx10=mix(n010,n110,u.x);
  float nxy0=mix(nx00,nx10,u.y);
  float nx01=mix(n001,n101,u.x), nx11=mix(n011,n111,u.x);
  float nxy1=mix(nx01,nx11,u.y);
  return mix(nxy0,nxy1,u.z);
}

float fbm(vec3 p, int oct){
  float a=0.5, f=1.0, s=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a * vnoise(p * f); f *= 2.02; a *= 0.5; }
  return s;
}

void main(){
  vec3 p  = vs_Pos.xyz;
  vec3 n  = normalize(p + 1e-6);
  vec3 Up = normalize(u_UpDir);

  // ----- Core: static noise -----
  float lowStatic =
      0.70 * sin(0.85 * p.y) +
      0.50 * cos(0.60 * p.z) +
      0.40 * sin(0.60 * p.x);
  float coreHi   = vnoise(p * 6.0);
  float coreDisp = u_CoreLowAmp * lowStatic + u_CoreHiAmp * (coreHi - 0.5);

  // Build a baseline displaced position for screen-space tests
  float baseDisp = coreDisp;
  if (u_Pass == 1) baseDisp = coreDisp + u_ShellOffset;
  if (u_Pass == 2) baseDisp = coreDisp + u_GlowOffset;
  vec3 basePos = p + n * baseDisp;

  // Convert baseline to NDC to measure mouse distance
  float baseScale = (u_Pass == 0) ? (u_SceneScale * u_CoreScale) : u_SceneScale;
  vec4 baseClip   = u_ViewProj * u_Model * vec4(basePos * baseScale, 1.0);
  vec2 ndc        = baseClip.xy / baseClip.w;

  // Mouse influence
  float fall = max(u_MouseFalloff, 1e-4);
  float d    = length(ndc - u_MouseNDC);
  float infl = exp(- (d / fall) * (d / fall));        // 1 at cursor, ~0 far away
  float mouseGate = (u_MouseOn == 1) ? 1.0 : 0.0;

  // Build a world-space tangent direction pointing toward the screen-space mouse
  // Create an orthonormal frame at the surface point
  vec3 a = (abs(n.y) < 0.99) ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 t1 = normalize(cross(n, a));
  vec3 t2 = normalize(cross(n, t1));
  vec2 toMouse2D = normalize(u_MouseNDC - ndc + 1e-6);
  vec3 toMouseWorld = normalize(toMouse2D.x * t1 + toMouse2D.y * t2);

  // Blend "Up" toward the mouse when infl>0 and pass is flames/glow
  float attract = mouseGate * infl * clamp(u_MouseStrength, 0.0, 2.0);
  vec3 UpDeform = normalize(mix(Up, toMouseWorld, (u_Pass == 0) ? 0.0 : attract));

  // ----- Flames / Glow -----
  float upDot     = clamp(dot(n, UpDeform), 0.0, 1.0);
  float topWeight = pow(upDot, 1.6);
  float fBM       = fbm(p * u_FlameNoiseScale + UpDeform * (0.7 * u_Time), u_Octaves);

  float flameDisp = coreDisp + topWeight * (u_FlameHiAmp * (fBM - 0.5) + u_FlameLift);

  // Apply mouse "pull" along the tangent toward the cursor for flames/glow
  float tangentialPull = 0.12 * attract;
  vec3 extra = (u_Pass == 0) ? vec3(0.0) : toMouseWorld * tangentialPull;

  float disp = coreDisp;
  if (u_Pass == 1) disp = flameDisp + u_ShellOffset;
  if (u_Pass == 2) disp = flameDisp + u_GlowOffset;

  vec3 displaced = p + n * disp + extra;

  // varyings
  v_Pos    = (u_Model * vec4(displaced, 1.0)).xyz;
  v_Core   = fBM;
  v_Height = disp;

  float r = length(displaced);
  v_Radial = 1.0 - smoothstep(0.78, 1.0, r);
  v_Rim    = smoothstep(0.94, 1.08, r);
  v_UpDot  = upDot;
  v_Grain  = vnoise(displaced * 32.0);

  float scale = (u_Pass == 0) ? (u_SceneScale * u_CoreScale) : u_SceneScale;
  vec4 modelPos = u_Model * vec4(displaced * scale, 1.0);
  gl_Position = u_ViewProj * modelPos;
}