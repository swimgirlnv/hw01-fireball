#version 300 es
precision highp float;
precision highp int;

in vec3  v_Pos;
in float v_Core;
in float v_Height;
in float v_Radial;
in float v_Rim;
in float v_Grain;
in float v_UpDot;

uniform float u_Time;
uniform int   u_BandCount;
uniform float u_Exposure;
uniform float u_Wash;
uniform float u_GrainAmp;
uniform float u_CoreHot;
uniform float u_GlowStrength;
uniform int   u_Pass;          // 0=core, 1=flames, 2=glow

out vec4 out_Col;

// ----------------- small helpers -----------------
vec3 satBoost(vec3 c, float s){
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return mix(vec3(l), c, 1.0 + s);
}
vec3 gamma(vec3 c, float g){ return pow(max(c, 0.0), vec3(g)); }

// ----------------- tiny noise for core cracks -----------------
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

// ----------------- palettes -----------------
vec3 firePalette_RYOB(float t){
  t = clamp(t, 0.0, 1.0);
  const vec3 B = vec3(0.12, 0.25, 1.00);
  const vec3 Y = vec3(1.00, 0.90, 0.00);
  const vec3 O = vec3(1.00, 0.50, 0.00);
  const vec3 R = vec3(0.95, 0.10, 0.05);
  if (t <= 0.3333) { float u = smoothstep(0.0, 0.3333, t); return mix(B, Y, u); }
  else if (t <= 0.6666) { float u = smoothstep(0.3333, 0.6666, t); return mix(Y, O, u); }
  else { float u = smoothstep(0.6666, 1.0, t); return mix(O, R, u); }
}
vec3 magmaRock(float t){ // dark rock body
  t = clamp(t, 0.0, 1.0);
  vec3 d1 = vec3(0.07, 0.04, 0.02);
  vec3 d2 = vec3(0.18, 0.10, 0.05);
  return mix(d1, d2, smoothstep(0.0, 1.0, t));
}
vec3 magmaGlowColor(){
  return vec3(3.0, 1.0, 0.2);
}

// ----------------- core magma with glowing cracks -----------------
vec3 magmaCracks(vec3 pos){
  // fbm field for cracks: low values = crack centers
  float n  = fbm(pos * 3.0, 5);
  float n2 = fbm(pos * 8.0 + 7.3, 3);
  float f  = 0.7 * n + 0.3 * n2;

  // Crack core (inverted): 1 at crack center → 0 on rock
  float crackCore = 1.0 - smoothstep(0.22, 0.28, f);

  float crackHalo = 1.0 - smoothstep(0.28, 0.46, f);

  // Dark rock body
  vec3 rock = magmaRock(0.4 + 0.6 * n);

  // Animate crack intensity slightly
  float flick = 1.0 + 0.5 * sin(u_Time * 4.0 + pos.y * 10.0) * cos(u_Time * 4.0 + pos.x * 10.0) * sin(u_Time * 4.0 + pos.z * 10.0);

  // Overexposed glow color ( > 1.0 ), scaled by core + halo
  vec3 glowCol = magmaGlowColor() * flick;

  vec3 emissive = glowCol * (1.5 * crackCore + 0.6 * crackHalo);

  vec3 col = rock + emissive;

  return col;
}

void main(){
  // ---------- PASS 0: Core (magma with cracks) ----------
  if (u_Pass == 0) {
    vec3 col = magmaCracks(v_Pos);
    col = mix(col, vec3(1.0), u_Wash * 0.18 * (1.0 - v_Radial));

    vec3 lit = col * (0.25 + 0.9 * clamp(u_Exposure, 0.0, 1.5));
    col = lit / (1.0 + lit);
    out_Col = vec4(clamp(col, 0.0, 1.0), 1.0);
    return;
  }

  // ---------- shared drivers for flames & glow ----------
  float base = 0.48 + 0.58 * v_Height + 0.18 * v_UpDot;
  float wob  = 0.05 * sin(u_Time * 2.6 + dot(v_Pos, vec3(0.7, 0.4, 0.2)));
  float grain= (v_Grain - 0.5) * u_GrainAmp;
  int   steps= max(u_BandCount, 2);
  float tBand= floor((base + wob + grain) * float(steps)) / float(steps);
  float t    = mix(base, tBand, 0.80);

  // ---------- PASS 1: Flames (colorful, top-biased, no white) ----------
  if (u_Pass == 1) {
    vec3 col = firePalette_RYOB(t);

    float flick   = 0.5 + 0.5 * sin(u_Time * 5.0 + v_Pos.y * 10.0);
    float heat    = clamp(v_Core * flick, 0.0, 1.0);
    float blueAmt = u_CoreHot * heat * pow(clamp(v_UpDot, 0.0, 1.0), 1.2);
    col = mix(col, vec3(0.12, 0.25, 1.00), 0.35 * blueAmt);

    col = gamma(col, 0.9);
    col = satBoost(col, 0.22);

    col = mix(col, vec3(1.0), u_Wash * 0.10 * (1.0 - v_Radial));

    vec3 lit = col * (0.25 + 1.25 * clamp(u_Exposure, 0.0, 1.5));
    col = lit / (1.0 + lit);
    col = clamp(col, 0.0, 1.0);

    float alpha = 0.18 * v_Rim * pow(clamp(v_UpDot, 0.0, 1.0), 1.6);

    out_Col = vec4(col, alpha);
    return;
  }

  // ---------- PASS 2: Glow (broad halo, top rim, additive) ----------
  float crown = pow(clamp(v_UpDot, 0.0, 1.0), 2.0);
  float halo  = smoothstep(0.60, 1.00, v_Rim);
  float a     = u_GlowStrength * 0.22 * crown * halo;

  vec3 glowC  = firePalette_RYOB(0.75 + 0.25 * v_UpDot);
  vec3 glit   = glowC * (0.25 + 1.25 * clamp(u_Exposure, 0.0, 1.5));
  glit = glit / (1.0 + glit);
  glit = clamp(glit, 0.0, 1.0);

  out_Col = vec4(glit, a);
}