;; The per-creature step of resident rows: memory units, turn, thrust, drag, ground, walls, rock and energy. Twin of Creature.remember and steer (physics.stepBody, the
;; reference): the same arithmetic in the same order, one f64 operation per JS operation and none fused, so the rows come out bit for bit alike. Math.sin and
;; Math.cos are the engine's own, imported, so the results equal the JS path on every engine. Offsets are layout.ts's, substituted for the double-brace tokens.
;; Keep this and stepBody in step: tests/typescript/wasmStep.test.ts compares them.
;; Memory is the brain bank's (imported); a row's brain outputs are f32 in the same memory.
(module
  (import "brain" "mem" (memory 1))
  (import "math" "sin" (func $sin (param f64) (result f64)))
  (import "math" "cos" (func $cos (param f64) (result f64)))

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

  ;; Pushes the disc out of the rock along the contact normal and reflects the velocity pointing into it, up to 4 passes (terrain.ts keepOut).
  (func $keepOut (param $P i32) (param $row i32) (param $sp i32)
    (local $radius f64) (local $bounce f64) (local $x f64) (local $y f64) (local $vx f64) (local $vy f64)
    (local $reach f64) (local $nx f64) (local $ny f64) (local $d2 f64) (local $d f64) (local $into f64) (local $e f64) (local $inv f64)
    (local $squareX f64) (local $squareY f64)
    (local $rockStart i32) (local $rockOrder i32) (local $rockXyr i32) (local $maxR f64)
    (local $pass i32) (local $moved i32) (local $cols i32) (local $cx0 i32) (local $cx1 i32) (local $cy1 i32) (local $cy i32) (local $k i32) (local $end i32) (local $disc i32)
    (if (i32.eqz (i32.load offset={{P_ROCKS}} (local.get $P))) (then (return)))
    (local.set $radius (f64.load offset={{Q_RADIUS}} (local.get $sp)))
    (local.set $bounce (f64.load offset={{Q_WALL_BOUNCE}} (local.get $sp)))
    (local.set $x (f64.load offset={{R_X}} (local.get $row)))
    (local.set $y (f64.load offset={{R_Y}} (local.get $row)))
    (local.set $vx (f64.load offset={{R_VX}} (local.get $row)))
    (local.set $vy (f64.load offset={{R_VY}} (local.get $row)))
    ;; early-out: the clear-of-rock raster square of the disc has no rock within reach (NaN fails the tests and takes the full path)
    (local.set $squareX (f64.floor (f64.div (local.get $x) (f64.load offset={{P_CLEAR_CELL}} (local.get $P)))))
    (local.set $squareY (f64.floor (f64.div (local.get $y) (f64.load offset={{P_CLEAR_CELL}} (local.get $P)))))
    (if (i32.and
          (i32.and (f64.ge (local.get $squareX) (f64.const 0)) (f64.lt (local.get $squareX) (f64.convert_i32_s (i32.load offset={{P_NEAR_COLS}} (local.get $P)))))
          (i32.and (f64.ge (local.get $squareY) (f64.const 0)) (f64.lt (local.get $squareY) (f64.convert_i32_s (i32.load offset={{P_NEAR_ROWS}} (local.get $P))))))
      (then
        (if (i32.eqz (i32.load8_u (i32.add (i32.load offset={{Q_NEAR}} (local.get $sp))
              (i32.add (i32.mul (i32.trunc_sat_f64_s (local.get $squareY)) (i32.load offset={{P_NEAR_COLS}} (local.get $P))) (i32.trunc_sat_f64_s (local.get $squareX))))))
          (then (return)))))
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
      (local.set $cos (call $cos (local.get $heading)))
      (local.set $sin (call $sin (local.get $heading)))
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
      (call $keepOut (local.get $P) (local.get $row) (local.get $sp))
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
