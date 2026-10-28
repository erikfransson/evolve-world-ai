;; The per-creature step of resident rows: memory units, turn, thrust, drag, ground, walls, rock and energy. Twin of Creature.remember and steer (physics.stepBody, the
;; reference): the same arithmetic in the same order, one f64 operation per JS operation and none fused, so the rows come out bit for bit alike. Math.sin and
;; Math.cos are the engine's own, imported, and replaced by a port of V8's fdlibm only when the loader's start-up probe (stepKernel.ts) finds the port equal to them. Offsets are layout.ts's, substituted for the double-brace tokens.
;; Keep this and stepBody in step: tests/typescript/wasmStep.test.ts compares them.
;; Memory is the brain bank's (imported); a row's brain outputs are f32 in the same memory.
(module
  (import "brain" "mem" (memory 1))
  (import "math" "sin" (func $sin (param f64) (result f64)))
  (import "math" "cos" (func $cos (param f64) (result f64)))

  (global $port (export "port") (mut i32) (i32.const 0)) ;; 1 once the probe found $sincos equal to the host's Math.sin and Math.cos

  (func $hi (param $x f64) (result i32)
    (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $x)) (i64.const 32))))

  (func $kcos (param $x f64) (param $y f64) (result f64)
    (local $ix i32) (local $z f64) (local $r f64) (local $qx f64)
    (local.set $ix (i32.and (call $hi (local.get $x)) (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3E400000))
      (then (if (i32.eqz (i32.trunc_f64_s (local.get $x))) (then (return (f64.const 1))))))
    (local.set $z (f64.mul (local.get $x) (local.get $x)))
    (local.set $r
      (f64.mul (local.get $z)
        (f64.add (f64.const 4.16666666666666019037e-02)
          (f64.mul (local.get $z)
            (f64.add (f64.const -1.38888888888741095749e-03)
              (f64.mul (local.get $z)
                (f64.add (f64.const 2.48015872894767294178e-05)
                  (f64.mul (local.get $z)
                    (f64.add (f64.const -2.75573143513906633035e-07)
                      (f64.mul (local.get $z)
                        (f64.add (f64.const 2.08757232129817482790e-09)
                          (f64.mul (local.get $z) (f64.const -1.13596475577881948265e-11)))))))))))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3FD33333))
      (then
        ;; 1 - (0.5 z - (z r - x y))
        (return (f64.sub (f64.const 1)
          (f64.sub (f64.mul (f64.const 0.5) (local.get $z))
            (f64.sub (f64.mul (local.get $z) (local.get $r)) (f64.mul (local.get $x) (local.get $y))))))))
    (if (i32.gt_s (local.get $ix) (i32.const 0x3FE90000))
      (then (local.set $qx (f64.const 0.28125)))
      (else (local.set $qx (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.sub (local.get $ix) (i32.const 0x00200000))) (i64.const 32))))))
    ;; (1 - qx) - ((0.5 z - qx) - (z r - x y))
    (f64.sub (f64.sub (f64.const 1) (local.get $qx))
      (f64.sub (f64.sub (f64.mul (f64.const 0.5) (local.get $z)) (local.get $qx))
        (f64.sub (f64.mul (local.get $z) (local.get $r)) (f64.mul (local.get $x) (local.get $y))))))

  (func $ksin (param $x f64) (param $y f64) (param $iy i32) (result f64)
    (local $ix i32) (local $z f64) (local $v f64) (local $r f64)
    (local.set $ix (i32.and (call $hi (local.get $x)) (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3E400000))
      (then (if (i32.eqz (i32.trunc_f64_s (local.get $x))) (then (return (local.get $x))))))
    (local.set $z (f64.mul (local.get $x) (local.get $x)))
    (local.set $v (f64.mul (local.get $z) (local.get $x)))
    (local.set $r
      (f64.add (f64.const 8.33333333332248946124e-03)
        (f64.mul (local.get $z)
          (f64.add (f64.const -1.98412698298579493134e-04)
            (f64.mul (local.get $z)
              (f64.add (f64.const 2.75573137070700676789e-06)
                (f64.mul (local.get $z)
                  (f64.add (f64.const -2.50507602534068634195e-08)
                    (f64.mul (local.get $z) (f64.const 1.58969099521155010221e-10))))))))))
    (if (i32.eqz (local.get $iy))
      (then
        ;; x + v (S1 + z r)
        (return (f64.add (local.get $x)
          (f64.mul (local.get $v) (f64.add (f64.const -1.66666666666666324348e-01) (f64.mul (local.get $z) (local.get $r))))))))
    ;; x - ((z (0.5 y - v r) - y) - v S1)
    (f64.sub (local.get $x)
      (f64.sub
        (f64.sub (f64.mul (local.get $z) (f64.sub (f64.mul (f64.const 0.5) (local.get $y)) (f64.mul (local.get $v) (local.get $r)))) (local.get $y))
        (f64.mul (local.get $v) (f64.const -1.66666666666666324348e-01)))))

  ;; fdlibm __ieee754_rem_pio2 for pi/4 < |x| <= 2^19 pi/2: returns n, y0, y1. n = 0x80000000 marks a larger finite |x|.
  (func $rem (param $x f64) (result i32 f64 f64)
    (local $hx i32) (local $ix i32) (local $z f64) (local $t f64) (local $n i32) (local $fn f64)
    (local $r f64) (local $w f64) (local $y0 f64) (local $y1 f64) (local $j i32) (local $i i32) (local $big i32)
    (local.set $hx (call $hi (local.get $x)))
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x4002D97C))
      (then
        (if (i32.gt_s (local.get $hx) (i32.const 0))
          (then
            (local.set $z (f64.sub (local.get $x) (f64.const 1.57079632673412561417e+00)))
            (if (i32.ne (local.get $ix) (i32.const 0x3FF921FB))
              (then
                (local.set $y0 (f64.sub (local.get $z) (f64.const 6.07710050650619224932e-11)))
                (local.set $y1 (f64.sub (f64.sub (local.get $z) (local.get $y0)) (f64.const 6.07710050650619224932e-11))))
              (else
                (local.set $z (f64.sub (local.get $z) (f64.const 6.07710050630396597660e-11)))
                (local.set $y0 (f64.sub (local.get $z) (f64.const 2.02226624879595063154e-21)))
                (local.set $y1 (f64.sub (f64.sub (local.get $z) (local.get $y0)) (f64.const 2.02226624879595063154e-21)))))
            (return (i32.const 1) (local.get $y0) (local.get $y1)))
          (else
            (local.set $z (f64.add (local.get $x) (f64.const 1.57079632673412561417e+00)))
            (if (i32.ne (local.get $ix) (i32.const 0x3FF921FB))
              (then
                (local.set $y0 (f64.add (local.get $z) (f64.const 6.07710050650619224932e-11)))
                (local.set $y1 (f64.add (f64.sub (local.get $z) (local.get $y0)) (f64.const 6.07710050650619224932e-11))))
              (else
                (local.set $z (f64.add (local.get $z) (f64.const 6.07710050630396597660e-11)))
                (local.set $y0 (f64.add (local.get $z) (f64.const 2.02226624879595063154e-21)))
                (local.set $y1 (f64.add (f64.sub (local.get $z) (local.get $y0)) (f64.const 2.02226624879595063154e-21)))))
            (return (i32.const -1) (local.get $y0) (local.get $y1))))))
    (if (i32.gt_s (local.get $ix) (i32.const 0x413921FB))
      (then (return (i32.const 0x80000000) (f64.const 0) (f64.const 0))))
    ;; medium size
    (local.set $t (f64.abs (local.get $x)))
    (local.set $n (i32.trunc_f64_s (f64.add (f64.mul (local.get $t) (f64.const 6.36619772367581382433e-01)) (f64.const 0.5))))
    (local.set $fn (f64.convert_i32_s (local.get $n)))
    (local.set $r (f64.sub (local.get $t) (f64.mul (local.get $fn) (f64.const 1.57079632673412561417e+00))))
    (local.set $w (f64.mul (local.get $fn) (f64.const 6.07710050650619224932e-11)))
    ;; quick check: n < 32 and ix differs from the high word of n pi/2
    (local.set $big
      (if (result i32) (i32.lt_s (local.get $n) (i32.const 32))
        (then (i32.ne (local.get $ix) (call $hi (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const 1.5707963267948966)))))
        (else (i32.const 0))))
    (if (local.get $big)
      (then (local.set $y0 (f64.sub (local.get $r) (local.get $w))))
      (else
        (local.set $j (i32.shr_s (local.get $ix) (i32.const 20)))
        (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
        (local.set $i (i32.sub (local.get $j) (i32.and (i32.shr_u (call $hi (local.get $y0)) (i32.const 20)) (i32.const 0x7ff))))
        (if (i32.gt_s (local.get $i) (i32.const 16))
          (then
            (local.set $t (local.get $r))
            (local.set $w (f64.mul (local.get $fn) (f64.const 6.07710050630396597660e-11)))
            (local.set $r (f64.sub (local.get $t) (local.get $w)))
            (local.set $w (f64.sub (f64.mul (local.get $fn) (f64.const 2.02226624879595063154e-21))
                                   (f64.sub (f64.sub (local.get $t) (local.get $r)) (local.get $w))))
            (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
            (local.set $i (i32.sub (local.get $j) (i32.and (i32.shr_u (call $hi (local.get $y0)) (i32.const 20)) (i32.const 0x7ff))))
            (if (i32.gt_s (local.get $i) (i32.const 49))
              (then
                (local.set $t (local.get $r))
                (local.set $w (f64.mul (local.get $fn) (f64.const 2.02226624871116645580e-21)))
                (local.set $r (f64.sub (local.get $t) (local.get $w)))
                (local.set $w (f64.sub (f64.mul (local.get $fn) (f64.const 8.47842766036889956997e-32))
                                       (f64.sub (f64.sub (local.get $t) (local.get $r)) (local.get $w))))
                (local.set $y0 (f64.sub (local.get $r) (local.get $w)))))))))
    (local.set $y1 (f64.sub (f64.sub (local.get $r) (local.get $y0)) (local.get $w)))
    (if (i32.lt_s (local.get $hx) (i32.const 0))
      (then (return (i32.sub (i32.const 0) (local.get $n)) (f64.neg (local.get $y0)) (f64.neg (local.get $y1)))))
    (local.get $n) (local.get $y0) (local.get $y1))

  ;; sin and cos of x as the engine's Math.sin and Math.cos compute them (fdlibm), or the imports where this port does not reach (|x| past 823549)
  (func $sincos (param $x f64) (result f64 f64)
    (local $ix i32) (local $n i32) (local $y0 f64) (local $y1 f64) (local $s f64) (local $c f64) (local $nan f64)
    (local.set $ix (i32.and (call $hi (local.get $x)) (i32.const 0x7fffffff)))
    (if (i32.le_s (local.get $ix) (i32.const 0x3FE921FB))
      (then (return (call $ksin (local.get $x) (f64.const 0) (i32.const 0)) (call $kcos (local.get $x) (f64.const 0)))))
    (if (i32.ge_s (local.get $ix) (i32.const 0x7FF00000))
      (then (return (call $sin (local.get $x)) (call $cos (local.get $x)))))
    (call $rem (local.get $x))
    (local.set $y1) (local.set $y0) (local.set $n)
    (if (i32.eq (local.get $n) (i32.const 0x80000000)) (then (return (call $sin (local.get $x)) (call $cos (local.get $x)))))
    (local.set $s (call $ksin (local.get $y0) (local.get $y1) (i32.const 1)))
    (local.set $c (call $kcos (local.get $y0) (local.get $y1)))
    (block $done
      (block $three (block $two (block $one
        (br_table $done $one $two $three (i32.and (local.get $n) (i32.const 3))))
        (return (local.get $c) (f64.neg (local.get $s))))
        (return (f64.neg (local.get $s)) (f64.neg (local.get $c))))
        (return (f64.neg (local.get $c)) (local.get $s)))
    (local.get $s) (local.get $c))
  (func (export "portSincos") (param $x f64) (result f64 f64) (call $sincos (local.get $x)))

  (func $trig (param $x f64) (result f64 f64)
    (if (result f64 f64) (global.get $port)
      (then (call $sincos (local.get $x)))
      (else (call $sin (local.get $x)) (call $cos (local.get $x)))))

  ;; Clamps one axis of a disc into [radius, size - radius] and reflects the velocity pointing into the wall, scaled by the restitution (physics.ts keepInside).
  (func $wall (param $pos i32) (param $vel i32) (param $radius f64) (param $size f64) (param $bounce f64)
    (local $p f64) (local $v f64)
    (local.set $p (f64.load (local.get $pos)))
    (local.set $v (f64.load (local.get $vel)))
    (if (f64.lt (local.get $p) (local.get $radius))
      (then
        (f64.store (local.get $pos) (local.get $radius))
        (if (f64.lt (local.get $v) (f64.const 0)) (then (f64.store (local.get $vel) (f64.mul (f64.neg (local.get $bounce)) (local.get $v))))))
      (else
        (if (f64.gt (local.get $p) (f64.sub (local.get $size) (local.get $radius)))
          (then
            (f64.store (local.get $pos) (f64.sub (local.get $size) (local.get $radius)))
            (if (f64.gt (local.get $v) (f64.const 0)) (then (f64.store (local.get $vel) (f64.mul (f64.neg (local.get $bounce)) (local.get $v)))))))))
  )

  ;; Pushes the disc out of the rock along the contact normal and reflects the velocity pointing into it, up to 4 passes (terrain.ts keepOut). The caller has run the clear-of-rock early-out.
  (func $keepOut (param $P i32) (param $row i32) (param $sp i32)
    (local $radius f64) (local $bounce f64) (local $x f64) (local $y f64) (local $vx f64) (local $vy f64)
    (local $reach f64) (local $nx f64) (local $ny f64) (local $d2 f64) (local $d f64) (local $into f64) (local $e f64) (local $inv f64)
    (local $rockStart i32) (local $rockOrder i32) (local $rockXyr i32) (local $maxR f64)
    (local $pass i32) (local $moved i32) (local $cols i32) (local $cx0 i32) (local $cx1 i32) (local $cy1 i32) (local $cy i32) (local $k i32) (local $end i32) (local $disc i32)
    (local.set $radius (f64.load offset={{Q_RADIUS}} (local.get $sp)))
    (local.set $bounce (f64.load offset={{Q_WALL_BOUNCE}} (local.get $sp)))
    (local.set $x (f64.load offset={{R_X}} (local.get $row)))
    (local.set $y (f64.load offset={{R_Y}} (local.get $row)))
    (local.set $vx (f64.load offset={{R_VX}} (local.get $row)))
    (local.set $vy (f64.load offset={{R_VY}} (local.get $row)))
    (local.set $cols (i32.load offset={{P_ROCK_COLS}} (local.get $P)))
    (local.set $rockStart (i32.load offset={{P_ROCK_START}} (local.get $P)))
    (local.set $rockOrder (i32.load offset={{P_ROCK_ORDER}} (local.get $P)))
    (local.set $rockXyr (i32.load offset={{P_ROCK_XYR}} (local.get $P)))
    (local.set $maxR (f64.load offset={{P_MAX_ROCK_R}} (local.get $P)))
    (local.set $inv (f64.load offset={{P_INV_ROCK_CELL}} (local.get $P)))
    (block $passesDone (loop $passLoop
      (br_if $passesDone (i32.ge_s (local.get $pass) (i32.const 4)))
      (local.set $moved (i32.const 0))
      ;; grid cells that can hold a disc touching the square around the creature (Terrain.cellRange). NaN becomes 0 like the Int32Array there. trunc_sat saturates where JS
      ;; wraps (ToInt32), which only matters for values past 2^31 cells, never reached since keepInside has bounded the position by now.
      (local.set $e (f64.add (local.get $radius) (local.get $maxR)))
      (local.set $cx0 (i32.trunc_sat_f64_s (f64.max (f64.const 0) (f64.floor (f64.mul (f64.sub (local.get $x) (local.get $e)) (local.get $inv))))))
      (local.set $cx1 (i32.trunc_sat_f64_s (f64.min (f64.convert_i32_s (i32.sub (local.get $cols) (i32.const 1))) (f64.floor (f64.mul (f64.add (local.get $x) (local.get $e)) (local.get $inv))))))
      (local.set $cy (i32.trunc_sat_f64_s (f64.max (f64.const 0) (f64.floor (f64.mul (f64.sub (local.get $y) (local.get $e)) (local.get $inv))))))
      (local.set $cy1 (i32.trunc_sat_f64_s (f64.min (f64.convert_i32_s (i32.sub (i32.load offset={{P_ROCK_ROWS}} (local.get $P)) (i32.const 1))) (f64.floor (f64.mul (f64.add (local.get $y) (local.get $e)) (local.get $inv))))))
      (block $rowsDone (loop $rowLoop
        (br_if $rowsDone (i32.gt_s (local.get $cy) (local.get $cy1)))
        ;; the discs of this grid row between the first and last cell, rockOrder[rockStart[first] .. rockStart[last + 1] - 1]
        ;; an empty or out-of-grid cell range (first column past the last) has no discs and must not index the table
        (local.set $k (i32.const 0))
        (local.set $end (i32.const 0))
        (if (i32.le_s (local.get $cx0) (local.get $cx1))
          (then
            (local.set $k (i32.load (i32.add (local.get $rockStart) (i32.shl (i32.add (i32.mul (local.get $cy) (local.get $cols)) (local.get $cx0)) (i32.const 2)))))
            (local.set $end (i32.load (i32.add (local.get $rockStart) (i32.shl (i32.add (i32.add (i32.mul (local.get $cy) (local.get $cols)) (local.get $cx1)) (i32.const 1)) (i32.const 2)))))))
        (block $discsDone (loop $discLoop
          (br_if $discsDone (i32.ge_s (local.get $k) (local.get $end)))
          ;; the disc is x, y, r at xyr + 24 * rockOrder[k]
          (local.set $disc (i32.add (local.get $rockXyr)
            (i32.mul (i32.load (i32.add (local.get $rockOrder) (i32.shl (local.get $k) (i32.const 2)))) (i32.const 24))))
          (local.set $reach (f64.add (f64.load offset=16 (local.get $disc)) (local.get $radius)))
          (local.set $nx (f64.sub (local.get $x) (f64.load (local.get $disc))))
          (local.set $ny (f64.sub (local.get $y) (f64.load offset=8 (local.get $disc))))
          (local.set $d2 (f64.add (f64.mul (local.get $nx) (local.get $nx)) (f64.mul (local.get $ny) (local.get $ny))))
          (if (i32.eqz (f64.ge (local.get $d2) (f64.mul (local.get $reach) (local.get $reach)))) ;; not ge, so a NaN distance counts as inside like in JS
            (then
              (local.set $d (f64.sqrt (local.get $d2)))
              (if (f64.gt (local.get $d) (f64.const 0))
                (then
                  (local.set $nx (f64.div (local.get $nx) (local.get $d)))
                  (local.set $ny (f64.div (local.get $ny) (local.get $d))))
                (else ;; centre on centre: leave along +x
                  (local.set $nx (f64.const 1))
                  (local.set $ny (f64.const 0))))
              (local.set $x (f64.add (f64.load (local.get $disc)) (f64.mul (local.get $nx) (local.get $reach))))
              (local.set $y (f64.add (f64.load offset=8 (local.get $disc)) (f64.mul (local.get $ny) (local.get $reach))))
              (local.set $into (f64.add (f64.mul (local.get $vx) (local.get $nx)) (f64.mul (local.get $vy) (local.get $ny))))
              (if (f64.lt (local.get $into) (f64.const 0))
                (then
                  (local.set $vx (f64.sub (local.get $vx) (f64.mul (f64.mul (f64.add (f64.const 1) (local.get $bounce)) (local.get $into)) (local.get $nx))))
                  (local.set $vy (f64.sub (local.get $vy) (f64.mul (f64.mul (f64.add (f64.const 1) (local.get $bounce)) (local.get $into)) (local.get $ny))))))
              (local.set $moved (i32.const 1))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $discLoop)))
        (local.set $cy (i32.add (local.get $cy) (i32.const 1)))
        (br $rowLoop)))
      (br_if $passesDone (i32.eqz (local.get $moved)))
      (local.set $pass (i32.add (local.get $pass) (i32.const 1)))
      (br $passLoop)))
    (f64.store offset={{R_X}} (local.get $row) (local.get $x))
    (f64.store offset={{R_Y}} (local.get $row) (local.get $y))
    (f64.store offset={{R_VX}} (local.get $row) (local.get $vx))
    (f64.store offset={{R_VY}} (local.get $row) (local.get $vy))
  )

  ;; Steps each of the n rows listed at P_ROWS, in that order.
  (func (export "step") (param $P i32)
    (local $near i32) (local $cx i32) (local $cy i32) (local $fx f64) (local $fy f64)
    (local $k i32) (local $n i32) (local $row i32) (local $sp i32) (local $out i32) (local $units i32) (local $count i32) (local $short i32) (local $u i32) (local $at i32)
    (local $dt f64) (local $thrust f64) (local $targetTurn f64) (local $turn f64) (local $heading f64) (local $cos f64) (local $sin f64)
    (local $vx0 f64) (local $vy0 f64) (local $vx f64) (local $vy f64) (local $v f64) (local $fwd f64) (local $side f64) (local $terminal f64) (local $slowed f64)
    (local $speciesAt i32) (local $rowsAt i32) (local $outputSize i32) (local $empty i32) (local $aging i32) (local $agingStart f64) (local $agingPerTick f64)
    (local $ground f64) (local $upkeep f64) (local $ticks f64) (local $radius f64) (local $bounce f64)
    (local.set $n (i32.load offset={{P_N}} (local.get $P)))
    (local.set $rowsAt (i32.load offset={{P_ROWS}} (local.get $P)))
    (local.set $speciesAt (i32.load offset={{P_SPECIES}} (local.get $P)))
    (local.set $outputSize (i32.load offset={{P_OUTPUT_SIZE}} (local.get $P)))
    (local.set $empty (i32.load offset={{P_EMPTY}} (local.get $P)))
    (local.set $aging (i32.load offset={{P_AGING}} (local.get $P)))
    (local.set $agingStart (f64.load offset={{P_AGING_START}} (local.get $P)))
    (local.set $agingPerTick (f64.load offset={{P_AGING_PER_TICK}} (local.get $P)))
    (block $rowsDone (loop $rowLoop
      (br_if $rowsDone (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $row (i32.load (i32.add (local.get $rowsAt) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $sp (i32.add (local.get $speciesAt) (i32.mul (i32.load offset={{R_SPECIES}} (local.get $row)) (i32.const {{Q_BYTES}}))))
      (local.set $out (i32.load offset={{R_OUT}} (local.get $row)))
      (local.set $dt (f64.load offset={{Q_DT}} (local.get $sp)))
      ;; remember: each unit moves toward its target output, at the short or the long rate
      (local.set $units (i32.load offset={{R_UNITS}} (local.get $row)))
      (local.set $count (i32.load offset={{R_UNIT_COUNT}} (local.get $row)))
      (local.set $short (i32.load offset={{R_SHORT}} (local.get $row)))
      (local.set $u (i32.const 0))
      (block $unitsDone (loop $unitLoop
        (br_if $unitsDone (i32.ge_s (local.get $u) (local.get $count)))
        (local.set $at (i32.add (local.get $units) (i32.shl (local.get $u) (i32.const 3))))
        (f64.store (local.get $at)
          (f64.add (f64.load (local.get $at))
            (f64.mul
              (select (f64.load offset={{Q_SHORT_RATE}} (local.get $sp)) (f64.load offset={{Q_LONG_RATE}} (local.get $sp)) (i32.lt_s (local.get $u) (local.get $short)))
              (f64.sub
                (f64.promote_f32 (f32.load (i32.add (local.get $out) (i32.shl (i32.add (local.get $outputSize) (local.get $u)) (i32.const 2)))))
                (f64.load (local.get $at))))))
        (local.set $u (i32.add (local.get $u) (i32.const 1)))
        (br $unitLoop)))
      ;; thrust command: brake below the threshold, else the output clipped at 0
      (local.set $thrust (f64.promote_f32 (f32.load offset=4 (local.get $out))))
      (local.set $thrust (select (f64.const -1) (f64.max (f64.const 0) (local.get $thrust)) (f64.lt (local.get $thrust) (f64.load offset={{Q_BRAKE_THRESHOLD}} (local.get $sp)))))
      ;; turn rate and heading
      (local.set $targetTurn (f64.mul (f64.promote_f32 (f32.load (local.get $out))) (f64.load offset={{Q_MAX_TURN}} (local.get $sp))))
      (local.set $turn (f64.add (local.get $targetTurn)
        (f64.mul (f64.sub (f64.load offset={{R_TURN}} (local.get $row)) (local.get $targetTurn)) (f64.load offset={{Q_DECAY_TURN}} (local.get $sp)))))
      (f64.store offset={{R_TURN}} (local.get $row) (local.get $turn))
      (local.set $heading (f64.add (f64.load offset={{R_HEADING}} (local.get $row)) (f64.mul (local.get $turn) (local.get $dt))))
      (f64.store offset={{R_HEADING}} (local.get $row) (local.get $heading))
      (call $trig (local.get $heading))
      (local.set $cos)
      (local.set $sin)
      (f64.store offset={{R_COS}} (local.get $row) (local.get $cos))
      (f64.store offset={{R_SIN}} (local.get $row) (local.get $sin))
      ;; velocity: forward speed toward the thrust's terminal speed (or braking), sideways speed decaying
      (local.set $vx0 (f64.load offset={{R_VX}} (local.get $row)))
      (local.set $vy0 (f64.load offset={{R_VY}} (local.get $row)))
      (local.set $v (f64.add (f64.mul (local.get $vx0) (local.get $cos)) (f64.mul (local.get $vy0) (local.get $sin))))
      (if (f64.ge (local.get $thrust) (f64.const 0))
        (then
          (local.set $terminal (f64.div (f64.mul (local.get $thrust) (f64.load offset={{Q_MAX_THRUST}} (local.get $sp))) (f64.load offset={{Q_DRAG}} (local.get $sp))))
          (local.set $fwd (f64.add (local.get $terminal) (f64.mul (f64.sub (local.get $v) (local.get $terminal)) (f64.load offset={{Q_DECAY_DRAG}} (local.get $sp))))))
        (else
          (local.set $slowed (f64.add
            (f64.mul (f64.abs (local.get $v)) (f64.load offset={{Q_DECAY_DRAG}} (local.get $sp)))
            (f64.mul (f64.mul (local.get $thrust) (f64.load offset={{Q_MAX_BRAKE}} (local.get $sp))) (local.get $dt))))
          (local.set $fwd (select
            (select (f64.neg (local.get $slowed)) (local.get $slowed) (f64.lt (local.get $v) (f64.const 0)))
            (f64.const 0)
            (f64.gt (local.get $slowed) (f64.const 0))))))
      (local.set $side (f64.mul
        (f64.add (f64.mul (f64.neg (local.get $vx0)) (local.get $sin)) (f64.mul (local.get $vy0) (local.get $cos)))
        (f64.load offset={{Q_DECAY_SIDE}} (local.get $sp))))
      (local.set $vx (f64.sub (f64.mul (local.get $fwd) (local.get $cos)) (f64.mul (local.get $side) (local.get $sin))))
      (local.set $vy (f64.add (f64.mul (local.get $fwd) (local.get $sin)) (f64.mul (local.get $side) (local.get $cos))))
      ;; position: the ground scales the distance moved
      (local.set $ground (select (f64.const 1) (f64.load offset={{R_GROUND_FACTOR}} (local.get $row)) (local.get $empty)))
      (f64.store offset={{R_X}} (local.get $row) (f64.add (f64.load offset={{R_X}} (local.get $row)) (f64.mul (f64.mul (local.get $vx) (local.get $dt)) (local.get $ground))))
      (f64.store offset={{R_Y}} (local.get $row) (f64.add (f64.load offset={{R_Y}} (local.get $row)) (f64.mul (f64.mul (local.get $vy) (local.get $dt)) (local.get $ground))))
      (f64.store offset={{R_VX}} (local.get $row) (local.get $vx))
      (f64.store offset={{R_VY}} (local.get $row) (local.get $vy))
      ;; walls, then rock
      (local.set $radius (f64.load offset={{Q_RADIUS}} (local.get $sp)))
      (local.set $bounce (f64.load offset={{Q_WALL_BOUNCE}} (local.get $sp)))
      (call $wall (i32.add (local.get $row) (i32.const {{R_X}})) (i32.add (local.get $row) (i32.const {{R_VX}})) (local.get $radius) (f64.load offset={{Q_WIDTH}} (local.get $sp)) (local.get $bounce))
      (call $wall (i32.add (local.get $row) (i32.const {{R_Y}})) (i32.add (local.get $row) (i32.const {{R_VY}})) (local.get $radius) (f64.load offset={{Q_HEIGHT}} (local.get $sp)) (local.get $bounce))
      ;; rock, unless the clear-of-rock raster square of the disc has no rock within reach (negative, NaN and out-of-raster positions take the full path)
      (if (i32.load offset={{P_ROCKS}} (local.get $P))
        (then
          (local.set $near (i32.const 1))
          (local.set $fx (f64.load offset={{R_X}} (local.get $row)))
          (local.set $fy (f64.load offset={{R_Y}} (local.get $row)))
          (if (i32.and (f64.ge (local.get $fx) (f64.const 0)) (f64.ge (local.get $fy) (f64.const 0)))
            (then
              (local.set $cx (i32.shr_u (i32.trunc_sat_f64_s (local.get $fx)) (i32.load offset={{P_CLEAR_SHIFT}} (local.get $P))))
              (local.set $cy (i32.shr_u (i32.trunc_sat_f64_s (local.get $fy)) (i32.load offset={{P_CLEAR_SHIFT}} (local.get $P))))
              (if (i32.and (i32.lt_u (local.get $cx) (i32.load offset={{P_NEAR_COLS}} (local.get $P))) (i32.lt_u (local.get $cy) (i32.load offset={{P_NEAR_ROWS}} (local.get $P))))
                (then
                  ;; the raster is a bit per square
                  (local.set $at (i32.add (i32.mul (local.get $cy) (i32.load offset={{P_NEAR_COLS}} (local.get $P))) (local.get $cx)))
                  (local.set $near (i32.and (i32.const 1) (i32.shr_u (i32.load8_u (i32.add (i32.load offset={{Q_NEAR}} (local.get $sp)) (i32.shr_u (local.get $at) (i32.const 3)))) (i32.and (local.get $at) (i32.const 7)))))))))
          (if (local.get $near) (then (call $keepOut (local.get $P) (local.get $row) (local.get $sp))))))
      ;; energy: the upkeep (grown with age), thrust and turning
      (local.set $upkeep (f64.load offset={{R_UPKEEP}} (local.get $row)))
      (local.set $ticks (f64.load offset={{R_TICKS}} (local.get $row)))
      (if (i32.and (local.get $aging) (f64.gt (local.get $ticks) (local.get $agingStart)))
        (then (local.set $upkeep (f64.mul (local.get $upkeep)
          (f64.add (f64.const 1) (f64.mul (local.get $agingPerTick) (f64.sub (local.get $ticks) (local.get $agingStart))))))))
      (f64.store offset={{R_ENERGY}} (local.get $row)
        (f64.sub (f64.load offset={{R_ENERGY}} (local.get $row))
          (f64.mul
            (f64.add
              (f64.add (local.get $upkeep) (f64.mul (f64.load offset={{Q_THRUST_COST}} (local.get $sp)) (f64.max (f64.const 0) (local.get $thrust))))
              (f64.div (f64.mul (f64.load offset={{Q_TURN_COST}} (local.get $sp)) (f64.abs (local.get $turn))) (f64.load offset={{Q_MAX_TURN}} (local.get $sp))))
            (local.get $dt))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $rowLoop)))
  )
)
