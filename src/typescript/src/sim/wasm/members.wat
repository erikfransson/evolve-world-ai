;; The two scans over the members' rows at the end of a tick (twins of the loops in Ecosystem.sharedPhase, which stay the reference and the fallback):
;; settle counts a tick alive for every creature with energy left and lists the others, and birthCandidates lists the first few members, in walk order, whose energy reaches their birth energy.
;; Offsets are layout.ts's (double-brace tokens). Keep in step with ecosystem.ts: tests/typescript/wasmMembers.test.ts compares them.
;; Memory is the brain bank's (imported).
(module
  (import "brain" "mem" (memory 1))

  ;; Members n-1 down to 0: ticksAlive + 1 when energy > 0 (NaN is not), else the member index into the list at M_OUT (descending), count at M_OUT_COUNT.
  (func (export "settle") (param $M i32)
    (local $i i32) (local $m i32) (local $row i32) (local $rowAt i32) (local $out i32)
    (local.set $i (i32.load offset={{M_N}} (local.get $M)))
    (local.set $rowAt (i32.load offset={{M_ROW_AT}} (local.get $M)))
    (local.set $out (i32.load offset={{M_OUT}} (local.get $M)))
    (block $done (loop $each
      (br_if $done (i32.le_s (local.get $i) (i32.const 0)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (local.set $row (i32.shl (i32.load (i32.add (local.get $rowAt) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 3)))
      (if (f64.gt (f64.load offset={{R_ENERGY}} (local.get $row)) (f64.const 0))
        (then (f64.store offset={{R_TICKS}} (local.get $row) (f64.add (f64.load offset={{R_TICKS}} (local.get $row)) (f64.const 1))))
        (else
          (i32.store (i32.add (local.get $out) (i32.shl (local.get $m) (i32.const 2))) (local.get $i))
          (local.set $m (i32.add (local.get $m) (i32.const 1)))))
      (br $each)))
    (i32.store offset={{M_OUT_COUNT}} (local.get $M) (local.get $m))
  )

  ;; From member M_FIRST on, round the list once (M_N members in all, M_STEPS already looked at): the members whose energy is not below their threshold (M_THRESHOLDS, f64 per member; a NaN energy counts),
  ;; into M_OUT in that order, until M_MAX are found. M_FIRST and M_STEPS then stand after the last member looked at, so another call goes on from there.
  (func (export "birthCandidates") (param $M i32)
    (local $k i32) (local $n i32) (local $at i32) (local $m i32) (local $max i32) (local $rowAt i32) (local $out i32) (local $thresholds i32)
    (local.set $n (i32.load offset={{M_N}} (local.get $M)))
    (local.set $max (i32.load offset={{M_MAX}} (local.get $M)))
    (local.set $rowAt (i32.load offset={{M_ROW_AT}} (local.get $M)))
    (local.set $out (i32.load offset={{M_OUT}} (local.get $M)))
    (local.set $thresholds (i32.load offset={{M_THRESHOLDS}} (local.get $M)))
    (local.set $at (i32.load offset={{M_FIRST}} (local.get $M)))
    (local.set $k (i32.load offset={{M_STEPS}} (local.get $M)))
    (block $done (loop $each
      (br_if $done (i32.ge_s (local.get $k) (local.get $n)))
      (br_if $done (i32.ge_s (local.get $m) (local.get $max)))
      (if (i32.eqz (f64.lt
            (f64.load offset={{R_ENERGY}} (i32.shl (i32.load (i32.add (local.get $rowAt) (i32.shl (local.get $at) (i32.const 2)))) (i32.const 3)))
            (f64.load (i32.add (local.get $thresholds) (i32.shl (local.get $at) (i32.const 3))))))
        (then
          (i32.store (i32.add (local.get $out) (i32.shl (local.get $m) (i32.const 2))) (local.get $at))
          (local.set $m (i32.add (local.get $m) (i32.const 1)))))
      ;; at = (first + k) % n, kept by stepping and wrapping
      (local.set $at (i32.add (local.get $at) (i32.const 1)))
      (if (i32.ge_s (local.get $at) (local.get $n)) (then (local.set $at (i32.const 0))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $each)))
    (i32.store offset={{M_FIRST}} (local.get $M) (local.get $at))
    (i32.store offset={{M_STEPS}} (local.get $M) (local.get $k))
    (i32.store offset={{M_OUT_COUNT}} (local.get $M) (local.get $m))
  )

  ;; One mulberry32 draw at state s as ga.ts mutate reads it (before the division by 2^32).
  (func $draw (param $s i32) (result i32)
    (local $t i32)
    (local.set $t (i32.mul (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 15))) (i32.or (local.get $s) (i32.const 1))))
    (local.set $t (i32.xor (i32.add (local.get $t) (i32.mul (i32.xor (local.get $t) (i32.shr_u (local.get $t) (i32.const 7))) (i32.or (local.get $t) (i32.const 61)))) (local.get $t)))
    (i32.xor (local.get $t) (i32.shr_u (local.get $t) (i32.const 14)))
  )

  (func $draw4 (param $s v128) (param $one v128) (param $k61 v128) (result v128)
    (local $t v128)
    (local.set $t (i32x4.mul (v128.xor (local.get $s) (i32x4.shr_u (local.get $s) (i32.const 15))) (v128.or (local.get $s) (local.get $one))))
    (local.set $t (v128.xor (i32x4.add (local.get $t) (i32x4.mul (v128.xor (local.get $t) (i32x4.shr_u (local.get $t) (i32.const 7))) (v128.or (local.get $t) (local.get $k61)))) (local.get $t)))
    (v128.xor (local.get $t) (i32x4.shr_u (local.get $t) (i32.const 14)))
  )

  ;; The scan of ga.ts mutate over M_N genes: gene g takes one mulberry32 draw (step 0x6d2b79f5 from the state at M_SEED), and when it is below M_LIMIT (unsigned) the gene mutates
  ;; and the next two draws are its normal's. Per mutated gene M_OUT gets three i32: the gene index and the two draws; M_OUT_COUNT is the number of genes, M_SEED the state after the last draw.
  ;; Four genes at a time while no one mutates: their draws are the states s + k x step, independent of each other.
  (func (export "mutateScan") (param $M i32)
    (local $n i32) (local $g i32) (local $s i32) (local $out i32) (local $limit i32) (local $lim v128) (local $mask i32) (local $m i32) (local $at i32) (local $step v128) (local $one v128) (local $k61 v128)
    (local.set $n (i32.load offset={{M_N}} (local.get $M)))
    (local.set $s (i32.load offset={{M_SEED}} (local.get $M)))
    (local.set $out (i32.load offset={{M_OUT}} (local.get $M)))
    (local.set $limit (i32.load offset={{M_LIMIT}} (local.get $M)))
    (local.set $lim (i32x4.splat (local.get $limit)))
    ;; constants in locals: V8 rebuilds a v128.const at each use inside a loop
    (local.set $step (v128.const i32x4 1831565813 3663131626 1199730143 3031295956))
    (local.set $one (v128.const i32x4 1 1 1 1))
    (local.set $k61 (v128.const i32x4 61 61 61 61))
    (block $done (loop $each
      (br_if $done (i32.ge_s (local.get $g) (local.get $n)))
      (block $hit
        (if (i32.le_s (i32.add (local.get $g) (i32.const 4)) (local.get $n))
          (then
            (local.set $mask (i32x4.bitmask (i32x4.lt_u
              (call $draw4 (i32x4.add (i32x4.splat (local.get $s)) (local.get $step)) (local.get $one) (local.get $k61))
              (local.get $lim))))
            (if (i32.eqz (local.get $mask))
              (then
                (local.set $s (i32.add (local.get $s) (i32.const 3031295956)))
                (local.set $g (i32.add (local.get $g) (i32.const 4)))
                (br $each)))
            ;; the first lane that mutates: its draw is done, genes before it drew too
            (local.set $mask (i32.ctz (local.get $mask)))
            (local.set $s (i32.add (local.get $s) (i32.mul (i32.add (local.get $mask) (i32.const 1)) (i32.const 1831565813))))
            (local.set $g (i32.add (local.get $g) (local.get $mask)))
            (br $hit)))
        (local.set $s (i32.add (local.get $s) (i32.const 1831565813)))
        (if (i32.ge_u (call $draw (local.get $s)) (local.get $limit))
          (then (local.set $g (i32.add (local.get $g) (i32.const 1))) (br $each))))
      (local.set $at (i32.add (local.get $out) (i32.mul (local.get $m) (i32.const 12))))
      (i32.store (local.get $at) (local.get $g))
      (local.set $s (i32.add (local.get $s) (i32.const 1831565813)))
      (i32.store offset=4 (local.get $at) (call $draw (local.get $s)))
      (local.set $s (i32.add (local.get $s) (i32.const 1831565813)))
      (i32.store offset=8 (local.get $at) (call $draw (local.get $s)))
      (local.set $m (i32.add (local.get $m) (i32.const 1)))
      (local.set $g (i32.add (local.get $g) (i32.const 1)))
      (br $each)))
    (i32.store offset={{M_OUT_COUNT}} (local.get $M) (local.get $m))
    (i32.store offset={{M_SEED}} (local.get $M) (local.get $s))
  )
)
