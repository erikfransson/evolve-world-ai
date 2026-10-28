;; The sense batch from resident creature rows (see resident.ts and layout.ts, whose offsets replace the double-brace tokens): per creature the 64-byte
;; sense record that sense.wat reads and the brain input extras (energy signal, speeds, turn, ground, then the memory units, as f32), and the
;; brain slot list of the batch. Creatures are placed in crowd grid (cell) order, read off the grid's owners, so neighbours share the cells sense.wat walks. Only moves data:
;; the extras are stored in the row as f64, by prepare (below) or, when the energy signal is not packed by the crowd kernel, by JS (residentStep.ts).
;; Memory is the brain bank's (imported).
;; The record is layout.ts's REC_* (sense.wat reads it).
(module
  (import "brain" "mem" (memory 1))

;; One layer of the ground field's bilinear blend at the node address p (stride bytes per raster row): 1 when it is of the layer's kind (GroundField.valueAt).
  (func $hit (param $p i32) (param $stride i32) (param $tx f64) (param $ty f64) (result i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32) (local $fa f64) (local $fb f64) (local $fc f64)
    (local.set $a (i32.load8_u (local.get $p)))
    (local.set $b (i32.load8_u offset=2 (local.get $p)))
    (local.set $p (i32.add (local.get $p) (local.get $stride)))
    (local.set $c (i32.load8_u (local.get $p)))
    (local.set $d (i32.load8_u offset=2 (local.get $p)))
    ;; no corner at 128 or more: below one half whatever the blend
    (if (i32.eqz (i32.and (i32.or (i32.or (local.get $a) (local.get $b)) (i32.or (local.get $c) (local.get $d))) (i32.const 128))) (then (return (i32.const 0))))
    (local.set $fa (f64.convert_i32_u (local.get $a)))
    (local.set $fb (f64.convert_i32_u (local.get $b)))
    (local.set $fc (f64.convert_i32_u (local.get $c)))
    (f64.ge
      (f64.add
        (f64.add
          (f64.add (local.get $fa) (f64.mul (f64.sub (local.get $fb) (local.get $fa)) (local.get $tx)))
          (f64.mul (f64.sub (local.get $fc) (local.get $fa)) (local.get $ty)))
        (f64.mul
          (f64.mul
            (f64.add (f64.sub (f64.sub (local.get $fa) (local.get $fb)) (local.get $fc)) (f64.convert_i32_u (local.get $d)))
            (local.get $tx))
          (local.get $ty)))
      (f64.const {{G_HALF}})))

  ;; Twin of prepareRows in residentStep.ts with the energy signal left out (the crowd kernel's pack stores it): forward and sideways speed, turn rate and the
  ;; ground value under the creature into the row's brain input extras, and the ground factor the step moves by; GroundField.valueAt for the value.
  (func (export "prepare") (param $G i32)
    (local $n i32) (local $k i32) (local $row i32) (local $sp i32) (local $raster i32) (local $stride i32) (local $empty i32)
    (local $cos f64) (local $sin f64) (local $vx f64) (local $vy f64) (local $drag f64) (local $thrust f64)
    (local $fx f64) (local $fy f64) (local $tx f64) (local $ty f64) (local $i i32) (local $j i32) (local $p i32) (local $value f64) (local $factor f64)
    (local.set $n (i32.load offset={{G_N}} (local.get $G)))
    (local.set $raster (i32.load offset={{G_RASTER}} (local.get $G)))
    (local.set $stride (i32.load offset={{G_STRIDE}} (local.get $G)))
    (local.set $empty (i32.load offset={{G_EMPTY}} (local.get $G)))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $row (i32.load (i32.add (i32.load offset={{G_ROWS}} (local.get $G)) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $sp (i32.add (i32.load offset={{G_SPECIES}} (local.get $G)) (i32.mul (i32.load offset={{R_SPECIES}} (local.get $row)) (i32.const {{H_BYTES}}))))
      (local.set $cos (f64.load offset={{R_COS}} (local.get $row)))
      (local.set $sin (f64.load offset={{R_SIN}} (local.get $row)))
      (local.set $vx (f64.load offset={{R_VX}} (local.get $row)))
      (local.set $vy (f64.load offset={{R_VY}} (local.get $row)))
      (local.set $drag (f64.load offset={{H_DRAG}} (local.get $sp)))
      (local.set $thrust (f64.load offset={{H_MAX_THRUST}} (local.get $sp)))
      (f64.store offset={{R_EXTRA_SPEED}} (local.get $row)
        (f64.div (f64.mul (f64.add (f64.mul (local.get $vx) (local.get $cos)) (f64.mul (local.get $vy) (local.get $sin))) (local.get $drag)) (local.get $thrust)))
      (f64.store offset={{R_EXTRA_SIDE}} (local.get $row)
        (f64.div (f64.mul (f64.sub (f64.mul (local.get $vy) (local.get $cos)) (f64.mul (local.get $vx) (local.get $sin))) (local.get $drag)) (local.get $thrust)))
      (f64.store offset={{R_EXTRA_TURN}} (local.get $row) (f64.div (f64.load offset={{R_TURN}} (local.get $row)) (f64.load offset={{H_MAX_TURN}} (local.get $sp))))
      (local.set $value (f64.const 0))
      (local.set $factor (f64.const 1))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.ne (local.get $raster) (i32.const 0))) (then
        ;; the node (i, j) at or below the point, and the fractions tx, ty past it
        (local.set $fx (f64.min (f64.load offset={{G_COL_MAX}} (local.get $G))
          (f64.max (f64.const 0) (f64.add (f64.mul (f64.load offset={{R_X}} (local.get $row)) (f64.load offset={{G_INV}} (local.get $G))) (f64.const {{G_PAD}})))))
        (local.set $fy (f64.min (f64.load offset={{G_ROW_MAX}} (local.get $G))
          (f64.max (f64.const 0) (f64.add (f64.mul (f64.load offset={{R_Y}} (local.get $row)) (f64.load offset={{G_INV}} (local.get $G))) (f64.const {{G_PAD}})))))
        (local.set $i (i32.trunc_sat_f64_s (local.get $fx)))
        (local.set $j (i32.trunc_sat_f64_s (local.get $fy)))
        (local.set $tx (f64.sub (local.get $fx) (f64.convert_i32_s (local.get $i))))
        (local.set $ty (f64.sub (local.get $fy) (f64.convert_i32_s (local.get $j))))
        (local.set $p (i32.add (local.get $raster) (i32.add (i32.mul (local.get $j) (local.get $stride)) (i32.shl (local.get $i) (i32.const 1)))))
        (if (call $hit (local.get $p) (local.get $stride) (local.get $tx) (local.get $ty))
          (then (local.set $value (f64.const -1)) (local.set $factor (f64.load offset={{G_SLOW}} (local.get $G))))
          (else (if (call $hit (i32.add (local.get $p) (i32.const 1)) (local.get $stride) (local.get $tx) (local.get $ty))
            (then (local.set $value (f64.const 1)) (local.set $factor (f64.load offset={{G_FAST}} (local.get $G)))))))))
      (f64.store offset={{R_EXTRA_GROUND}} (local.get $row) (local.get $value))
      (f64.store offset={{R_GROUND_FACTOR}} (local.get $row) (local.get $factor))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
  )

  ;; n f64 at src stored as f32 at dst, two at a time (f32x4.demote_f64x2_zero rounds each lane as f32.demote_f64)
  (func $narrow (param $dst i32) (param $src i32) (param $n i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_s (i32.add (local.get $i) (i32.const 1)) (local.get $n)))
      (v128.store64_lane align=4 0 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (f32x4.demote_f64x2_zero (v128.load align=8 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 3))))))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (if (i32.lt_s (local.get $i) (local.get $n)) (then
      (f32.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (f32.demote_f64 (f64.load (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 3))))))))
  )

  (func (export "fill") (param $F i32)
    (local $n i32) (local $k i32) (local $rows i32) (local $place i32) (local $inv i32) (local $ncrowd i32) (local $owners i32) (local $r i32) (local $row i32) (local $q i32) (local $rec i32)
    (local $v i32) (local $at i32) (local $nR i32) (local $in i32) (local $detailRow i32)
    (local $selves i32) (local $recs i32) (local $slots i32) (local $stride i32) (local $detailPtr i32) (local $ints v128)
    (local.set $n (i32.load offset={{F_N}} (local.get $F)))
    (local.set $rows (i32.load offset={{F_ROWS}} (local.get $F)))
    (local.set $place (i32.load offset={{F_PLACE}} (local.get $F)))
    (local.set $inv (i32.load offset={{F_COUNT}} (local.get $F)))
    (local.set $ncrowd (i32.load offset={{F_CROWD_N}} (local.get $F)))
    (local.set $owners (i32.load offset={{F_OWNERS}} (local.get $F)))
    (local.set $detailRow (i32.load offset={{F_DETAIL_ROW}} (local.get $F)))
    ;; place[k] = the record position of batch member k: the members in crowd (cell) order, read off the grid's owners; inv[self] = k + 1 for the members, 0 for the rest
    (memory.fill (local.get $inv) (i32.const 0) (i32.shl (local.get $ncrowd) (i32.const 2)))
    (block $cd (loop $cl
      (br_if $cd (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $r (i32.load (i32.add (i32.load offset={{F_SELVES}} (local.get $F)) (i32.shl (local.get $k) (i32.const 2)))))
      (if (i32.ge_u (local.get $r) (local.get $ncrowd)) (then unreachable))
      (i32.store (i32.add (local.get $inv) (i32.shl (local.get $r) (i32.const 2))) (i32.add (local.get $k) (i32.const 1)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $cl)))
    (local.set $q (i32.const 0))
    (local.set $r (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_s (local.get $r) (local.get $ncrowd)))
      (local.set $v (i32.load (i32.add (local.get $inv) (i32.shl (i32.load (i32.add (local.get $owners) (i32.shl (local.get $r) (i32.const 2)))) (i32.const 2)))))
      (if (local.get $v) (then
        (i32.store (i32.add (local.get $place) (i32.shl (i32.sub (local.get $v) (i32.const 1)) (i32.const 2))) (local.get $q))
        (local.set $q (i32.add (local.get $q) (i32.const 1)))))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $pl)))
    (local.set $k (i32.const 0))
    (local.set $selves (i32.load offset={{F_SELVES}} (local.get $F)))
    (local.set $recs (i32.load offset={{F_REC}} (local.get $F)))
    (local.set $slots (i32.load offset={{F_SLOTS}} (local.get $F)))
    (local.set $stride (i32.load offset={{F_STRIDE}} (local.get $F)))
    (local.set $detailPtr (i32.load offset={{F_DETAIL_PTR}} (local.get $F)))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $row (i32.load (i32.add (local.get $rows) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $q (i32.load (i32.add (local.get $place) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $rec (i32.add (local.get $recs) (i32.shl (local.get $q) (i32.const {{REC_SHIFT}}))))
      ;; x, y and cos, sin are adjacent in the row and in the record (layout.ts), and rays, offsets, input and slot are four adjacent i32 in the row
      (v128.store offset={{REC_X}} (local.get $rec) (v128.load offset={{R_X}} (local.get $row)))
      (v128.store offset={{REC_COS}} (local.get $rec) (v128.load offset={{R_COS}} (local.get $row)))
      (f64.store offset={{REC_RAY_LENGTH}} (local.get $rec) (f64.load offset={{R_RAY_LENGTH}} (local.get $row)))
      (i32.store offset={{REC_SELF}} (local.get $rec) (i32.load (i32.add (local.get $selves) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $ints (v128.load offset={{R_RAYS}} (local.get $row)))
      (local.set $nR (i32x4.extract_lane 0 (local.get $ints)))
      (local.set $in (i32x4.extract_lane 2 (local.get $ints)))
      (v128.store offset={{REC_RAYS}} (local.get $rec)
        (i32x4.replace_lane 3 (local.get $ints) (select (local.get $detailPtr) (i32.const 0) (i32.eq (local.get $row) (local.get $detailRow)))))
      (i32.store (i32.add (local.get $slots) (i32.shl (local.get $k) (i32.const 2))) (i32x4.extract_lane 3 (local.get $ints)))
      ;; brain input extras at input + 4 * rays * stride, then the memory units
      (local.set $at (i32.add (local.get $in) (i32.shl (i32.mul (local.get $nR) (local.get $stride)) (i32.const 2))))
      (call $narrow (local.get $at) (i32.add (local.get $row) (i32.const {{R_EXTRAS}})) (i32.const {{EXTRAS}}))
      (call $narrow (i32.add (local.get $at) (i32.const {{UNITS_AT}})) (i32.load offset={{R_UNITS}} (local.get $row)) (i32.load offset={{R_UNIT_COUNT}} (local.get $row)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $fl))))
)
