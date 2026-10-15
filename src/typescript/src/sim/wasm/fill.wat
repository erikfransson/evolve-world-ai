;; The sense batch from resident creature rows (see resident.ts and layout.ts, whose offsets replace the double-brace tokens): per creature the 64-byte
;; sense record that sense.wat reads and the brain input extras (energy signal, speeds, turn, ground, then the memory units, as f32), and the
;; brain slot list of the batch. Creatures are counting-sorted by item grid row (stable), which is the order sense.wat walks. Only moves data:
;; the extras are computed in JS (residentStep.ts) and stored in the row as f64.
;; Memory is the brain bank's (imported).
;; The record is layout.ts's REC_* (sense.wat reads it).
(module
  (import "brain" "mem" (memory 1))

  (func (export "fill") (param $F i32)
    (local $n i32) (local $k i32) (local $rows i32) (local $place i32) (local $count i32) (local $nrows i32) (local $r i32) (local $row i32) (local $q i32) (local $rec i32)
    (local $v f64) (local $at i32) (local $nR i32) (local $in i32) (local $units i32) (local $u i32) (local $up i32) (local $detailRow i32) (local $inv f64) (local $x i32)
    (local.set $n (i32.load offset={{F_N}} (local.get $F)))
    (local.set $rows (i32.load offset={{F_ROWS}} (local.get $F)))
    (local.set $place (i32.load offset={{F_PLACE}} (local.get $F)))
    (local.set $count (i32.load offset={{F_COUNT}} (local.get $F)))
    (local.set $nrows (i32.load offset={{F_ITEM_ROWS}} (local.get $F)))
    (local.set $inv (f64.load offset={{F_INV_CELL}} (local.get $F)))
    (local.set $detailRow (i32.load offset={{F_DETAIL_ROW}} (local.get $F)))
    ;; counts per item grid row: count[row + 1]++
    (local.set $r (i32.const 0))
    (block $zd (loop $zl
      (br_if $zd (i32.gt_s (local.get $r) (local.get $nrows)))
      (i32.store (i32.add (local.get $count) (i32.shl (local.get $r) (i32.const 2))) (i32.const 0))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $zl)))
    (block $cd (loop $cl
      (br_if $cd (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $row (i32.load (i32.add (local.get $rows) (i32.shl (local.get $k) (i32.const 2)))))
      (local.set $v (f64.floor (f64.mul (f64.load offset={{R_Y}} (local.get $row)) (local.get $inv))))
      ;; NaN and negative go to row 0
      (local.set $r (select
        (select (i32.sub (local.get $nrows) (i32.const 1)) (i32.trunc_sat_f64_s (local.get $v)) (f64.ge (local.get $v) (f64.convert_i32_s (local.get $nrows))))
        (i32.const 0)
        (f64.ge (local.get $v) (f64.const 0))))
      (i32.store (i32.add (local.get $place) (i32.shl (local.get $k) (i32.const 2))) (local.get $r))
      (local.set $r (i32.add (i32.shl (i32.add (local.get $r) (i32.const 1)) (i32.const 2)) (local.get $count)))
      (i32.store (local.get $r) (i32.add (i32.load (local.get $r)) (i32.const 1)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $cl)))
    (local.set $r (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_s (local.get $r) (local.get $nrows)))
      (i32.store offset=4 (i32.add (local.get $count) (i32.shl (local.get $r) (i32.const 2)))
        (i32.add (i32.load offset=4 (i32.add (local.get $count) (i32.shl (local.get $r) (i32.const 2))))
                 (i32.load (i32.add (local.get $count) (i32.shl (local.get $r) (i32.const 2))))))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $pl)))
    (local.set $k (i32.const 0))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_s (local.get $k) (local.get $n)))
      (local.set $row (i32.load (i32.add (local.get $rows) (i32.shl (local.get $k) (i32.const 2)))))
      ;; q = count[grid row]++, the record position
      (local.set $at (i32.add (local.get $count) (i32.shl (i32.load (i32.add (local.get $place) (i32.shl (local.get $k) (i32.const 2)))) (i32.const 2))))
      (local.set $q (i32.load (local.get $at)))
      (i32.store (local.get $at) (i32.add (local.get $q) (i32.const 1)))
      (local.set $rec (i32.add (i32.load offset={{F_REC}} (local.get $F)) (i32.shl (local.get $q) (i32.const {{REC_SHIFT}}))))
      (local.set $nR (i32.load offset={{R_RAYS}} (local.get $row)))
      (f64.store offset={{REC_X}} (local.get $rec) (f64.load offset={{R_X}} (local.get $row)))
      (f64.store offset={{REC_Y}} (local.get $rec) (f64.load offset={{R_Y}} (local.get $row)))
      (f64.store offset={{REC_COS}} (local.get $rec) (f64.load offset={{R_COS}} (local.get $row)))
      (f64.store offset={{REC_SIN}} (local.get $rec) (f64.load offset={{R_SIN}} (local.get $row)))
      (f64.store offset={{REC_RAY_LENGTH}} (local.get $rec) (f64.load offset={{R_RAY_LENGTH}} (local.get $row)))
      (i32.store offset={{REC_SELF}} (local.get $rec) (i32.load (i32.add (i32.load offset={{F_SELVES}} (local.get $F)) (i32.shl (local.get $k) (i32.const 2)))))
      (i32.store offset={{REC_RAYS}} (local.get $rec) (local.get $nR))
      (i32.store offset={{REC_OFFSETS}} (local.get $rec) (i32.load offset={{R_OFFSETS}} (local.get $row)))
      (local.set $in (i32.load offset={{R_INPUT}} (local.get $row)))
      (i32.store offset={{REC_INPUT}} (local.get $rec) (local.get $in))
      (i32.store offset={{REC_DETAIL}} (local.get $rec) (select (i32.load offset={{F_DETAIL_PTR}} (local.get $F)) (i32.const 0) (i32.eq (local.get $row) (local.get $detailRow))))
      (i32.store (i32.add (i32.load offset={{F_SLOTS}} (local.get $F)) (i32.shl (local.get $k) (i32.const 2))) (i32.load offset={{R_SLOT}} (local.get $row)))
      ;; brain input extras at input + 4 * rays * stride, then the memory units
      (local.set $at (i32.add (local.get $in) (i32.shl (i32.mul (local.get $nR) (i32.load offset={{F_STRIDE}} (local.get $F))) (i32.const 2))))
      (local.set $x (i32.const 0))
      (block $xd (loop $xl
        (br_if $xd (i32.ge_s (local.get $x) (i32.const {{EXTRAS}})))
        (f32.store (i32.add (local.get $at) (i32.shl (local.get $x) (i32.const 2)))
          (f32.demote_f64 (f64.load offset={{R_EXTRAS}} (i32.add (local.get $row) (i32.shl (local.get $x) (i32.const 3))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $xl)))
      (local.set $u (i32.const 0))
      (local.set $units (i32.load offset={{R_UNIT_COUNT}} (local.get $row)))
      (local.set $up (i32.load offset={{R_UNITS}} (local.get $row)))
      (block $ud (loop $ul
        (br_if $ud (i32.ge_s (local.get $u) (local.get $units)))
        (f32.store offset={{UNITS_AT}} (i32.add (local.get $at) (i32.shl (local.get $u) (i32.const 2)))
          (f32.demote_f64 (f64.load (i32.add (local.get $up) (i32.shl (local.get $u) (i32.const 3))))))
        (local.set $u (i32.add (local.get $u) (i32.const 1)))
        (br $ul)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $fl))))
)
