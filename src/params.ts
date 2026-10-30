// 調整用パラメータ。単位は m / s / rad。ここだけ触れば飛行感を変えられる。
export const PHYS = {
  gravity: 9.8,
  // --- 翼の空力 (加速度 = K * 係数 * 速度^2) ---
  liftK: 0.09,          // 揚力・抗力の共通係数 (大きいほど低速でも浮く)
  cl0: 0.45,           // 迎え角0での揚力係数
  clSlope: 3.2,        // 迎え角1radあたりの揚力係数の増え
  alphaStall: 0.3,     // 失速する迎え角(約17°)
  clAfterStall: 0.45,  // 失速後の揚力係数の下限
  clDropRate: 3.0,     // 失速後に揚力が落ちる速さ
  cd0: 0.04,           // 形状抗力
  kInduced: 0.06,      // 誘導抗力 (CL^2 に比例)
  flatPlateDrag: 1.2,  // 迎え角が大きいときの追加抗力
  brakeDrag: 3.0,      // ブレーキ時の抗力倍率増分
  brakeCl: 0.25,       // ブレーキ(フレア)時の揚力係数の上乗せ
  // --- 羽ばたき ---
  strokeTime: 0.36,    // 1回の羽ばたき時間
  flapThrust: 7,      // 前進加速度のピーク
  flapLift: 12,        // 上向き加速度のピーク
  // --- 姿勢・操舵 ---
  flapMaxSpeed: 22,    // 羽ばたきだけではこの速度までしか出ない(推力が先細る)
  maxDiveSpeed: 40,    // 急降下の安全上限(通常は抗力で約35m/sに落ち着く)
  trimPitch: 0.1,      // 操作なしの機首角(約6°)
  maxClimbPitch: 0.6,
  maxDivePitch: 1.15,
  pitchResponse: 4.0,
  stallRecoverPitch: -0.5, // 失速中は自動で機首を下げる
  pitchLimit: 1.3,
  turnRate: 1.7,       // 最大旋回速度 rad/s
  controlSpeed: 9,     // この速度未満では舵の効きが落ちる
  maxBank: 0.9,
  bankResponse: 5.0,
  sideDamp: 4.5,       // 横滑りが消える速さ (小さいと慣性で流れる)
  turnKeep: 0.9,       // 横滑りを機首方向へ向け直すとき、その速さのうち残す割合(1=損失なし)
  // --- 地面・着地 ---
  feetOffset: 0.32,    // 中心から足先まで
  bodyRadius: 0.35,
  safeSink: 6.5,       // これ以下の沈下速度なら安全着地
  safeSpeed: 19,
  rolloutDecel: 6,
  rolloutBrake: 8,
  groundTurn: 1.8,
  walkSpeed: 2.0,      // 歩行の最高速度 m/s
  walkAccel: 8, walkDecel: 14,
  stepUp: 0.35,        // これ以下の段差は歩いて越える。超えると壁として止まる
  edgeForgive: 0.45,   // 空中の足が上面の下この距離以内なら壁ではなく上面への着地として扱う(縁すれすれの着地を許容)
  edgeForgiveSpeed: 9, // …ただし水平速度がこれ未満のとき
  stepDown: 0.2,       // これ以下の段差は歩いて降りる(超えると落下)
  hopUp: 3.4,          // 小ジャンプの初速(頂点約0.6m)
  hopForward: 1.6,
  perchRadius: 0.8,    // 電線をつかめる距離(足先〜電線)。これより遠くからは吸着しない
  perchMaxSpeed: 8,    // これより速いと通過するだけ
  perchMaxRise: 1.2,   // 上昇中(これ以上)は着地しない
  perchCooldown: 0.4,  // 電線を離れた直後は再び捕まえない
  perchWalk: 0.9,      // 電線上を横歩きする速さ m/s
  perchHopForward: 1.1,// 電線からの小ジャンプ(隣の電線は約0.9m)
  hopTapTime: 0.22,    // これより短い押下=小ジャンプ。押し続けると離陸の羽ばたきへ移る
  takeoffSpeed: 5,
  takeoffUp: 4.5,
  wallCrashSpeed: 7,
  stunTime: 0.7,
  bound: 205,
  maxAltitude: 160,
};
