;; Batched Brain.forward in f32x4 SIMD.
;; Per creature a 64-byte descriptor (i32 words): 0 weights ptr, 1 input ptr, 2 output ptr, 3 layer-size count, 4.. layer sizes (up to 12).
;; Weights per layer, input-major: W[nIn][nPad] then bias[nPad], with nPad = nOut rounded up to a multiple of 8 and padding zeros.
;; Same math as the JS Brain: sums add in input order, first layer skips zero inputs, same Pade tanh with hard saturation.
(module
  (memory (export "mem") 1)

  (func $tanh (param $x v128) (result v128)
    (local $c v128) (local $x2 v128) (local $n v128) (local $d v128) (local $r v128)
    (local.set $c (f32x4.min (f32x4.max (local.get $x) (v128.const f32x4 -4.97 -4.97 -4.97 -4.97)) (v128.const f32x4 4.97 4.97 4.97 4.97)))
    (local.set $x2 (f32x4.mul (local.get $c) (local.get $c)))
    (local.set $n (f32x4.mul (local.get $c)
      (f32x4.add (v128.const f32x4 135135 135135 135135 135135)
        (f32x4.mul (local.get $x2) (f32x4.add (v128.const f32x4 17325 17325 17325 17325)
          (f32x4.mul (local.get $x2) (f32x4.add (v128.const f32x4 378 378 378 378) (local.get $x2))))))))
    (local.set $d (f32x4.add (v128.const f32x4 135135 135135 135135 135135)
      (f32x4.mul (local.get $x2) (f32x4.add (v128.const f32x4 62370 62370 62370 62370)
        (f32x4.mul (local.get $x2) (f32x4.add (v128.const f32x4 3150 3150 3150 3150)
          (f32x4.mul (local.get $x2) (v128.const f32x4 28 28 28 28))))))))
    (local.set $r (f32x4.min (f32x4.max (f32x4.div (local.get $n) (local.get $d)) (v128.const f32x4 -1 -1 -1 -1)) (v128.const f32x4 1 1 1 1)))
    ;; |x| >= 4.97 gives exactly +-1, as the JS version does
    (v128.bitselect
      (v128.or (v128.and (local.get $x) (v128.const i32x4 0x80000000 0x80000000 0x80000000 0x80000000)) (v128.const f32x4 1 1 1 1))
      (local.get $r)
      (f32x4.ge (f32x4.abs (local.get $x)) (v128.const f32x4 4.97 4.97 4.97 4.97))))

  ;; 16 outputs at column byte offset jb: four accumulators hide the add latency and one zero test serves all of them.
  (func $block4 (param $src i32) (param $nIn i32) (param $w i32) (param $stride i32) (param $jb i32) (param $dst i32) (param $sparse i32)
    (local $i i32) (local $ip i32) (local $p i32) (local $b i32)
    (local $v f32) (local $vs v128) (local $a0 v128) (local $a1 v128) (local $a2 v128) (local $a3 v128)
    (local.set $b (i32.add (i32.add (local.get $w) (i32.mul (local.get $nIn) (local.get $stride))) (local.get $jb)))
    (local.set $a0 (v128.load (local.get $b)))
    (local.set $a1 (v128.load offset=16 (local.get $b)))
    (local.set $a2 (v128.load offset=32 (local.get $b)))
    (local.set $a3 (v128.load offset=48 (local.get $b)))
    (local.set $ip (local.get $src))
    (local.set $p (i32.add (local.get $w) (local.get $jb)))
    (block $id (loop $il
      (br_if $id (i32.ge_u (local.get $i) (local.get $nIn)))
      (local.set $v (f32.load (local.get $ip)))
      (if (i32.eqz (i32.and (local.get $sparse) (f32.eq (local.get $v) (f32.const 0)))) (then
        (local.set $vs (f32x4.splat (local.get $v)))
        (local.set $a0 (f32x4.add (local.get $a0) (f32x4.mul (v128.load (local.get $p)) (local.get $vs))))
        (local.set $a1 (f32x4.add (local.get $a1) (f32x4.mul (v128.load offset=16 (local.get $p)) (local.get $vs))))
        (local.set $a2 (f32x4.add (local.get $a2) (f32x4.mul (v128.load offset=32 (local.get $p)) (local.get $vs))))
        (local.set $a3 (f32x4.add (local.get $a3) (f32x4.mul (v128.load offset=48 (local.get $p)) (local.get $vs))))))
      (local.set $ip (i32.add (local.get $ip) (i32.const 4)))
      (local.set $p (i32.add (local.get $p) (local.get $stride)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $il)))
    (local.set $b (i32.add (local.get $dst) (local.get $jb)))
    (v128.store (local.get $b) (call $tanh (local.get $a0)))
    (v128.store offset=16 (local.get $b) (call $tanh (local.get $a1)))
    (v128.store offset=32 (local.get $b) (call $tanh (local.get $a2)))
    (v128.store offset=48 (local.get $b) (call $tanh (local.get $a3))))

  ;; The same for 8 outputs.
  (func $block2 (param $src i32) (param $nIn i32) (param $w i32) (param $stride i32) (param $jb i32) (param $dst i32) (param $sparse i32)
    (local $i i32) (local $ip i32) (local $p i32) (local $b i32)
    (local $v f32) (local $vs v128) (local $a0 v128) (local $a1 v128)
    (local.set $b (i32.add (i32.add (local.get $w) (i32.mul (local.get $nIn) (local.get $stride))) (local.get $jb)))
    (local.set $a0 (v128.load (local.get $b)))
    (local.set $a1 (v128.load offset=16 (local.get $b)))
    (local.set $ip (local.get $src))
    (local.set $p (i32.add (local.get $w) (local.get $jb)))
    (block $id (loop $il
      (br_if $id (i32.ge_u (local.get $i) (local.get $nIn)))
      (local.set $v (f32.load (local.get $ip)))
      (if (i32.eqz (i32.and (local.get $sparse) (f32.eq (local.get $v) (f32.const 0)))) (then
        (local.set $vs (f32x4.splat (local.get $v)))
        (local.set $a0 (f32x4.add (local.get $a0) (f32x4.mul (v128.load (local.get $p)) (local.get $vs))))
        (local.set $a1 (f32x4.add (local.get $a1) (f32x4.mul (v128.load offset=16 (local.get $p)) (local.get $vs))))))
      (local.set $ip (i32.add (local.get $ip) (i32.const 4)))
      (local.set $p (i32.add (local.get $p) (local.get $stride)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $il)))
    (local.set $b (i32.add (local.get $dst) (local.get $jb)))
    (v128.store (local.get $b) (call $tanh (local.get $a0)))
    (v128.store offset=16 (local.get $b) (call $tanh (local.get $a1))))

  ;; One layer: dst[0..nPad) = tanh(bias + sum_i src[i] * W[i][..]); sparse skips zero inputs.
  (func $layer (param $src i32) (param $nIn i32) (param $w i32) (param $nPad i32) (param $dst i32) (param $sparse i32)
    (local $jb i32) (local $stride i32)
    (local.set $stride (i32.shl (local.get $nPad) (i32.const 2)))
    (block $jd (loop $jl
      (br_if $jd (i32.ge_u (local.get $jb) (local.get $stride)))
      (if (i32.le_u (i32.add (local.get $jb) (i32.const 64)) (local.get $stride))
        (then
          (call $block4 (local.get $src) (local.get $nIn) (local.get $w) (local.get $stride) (local.get $jb) (local.get $dst) (local.get $sparse))
          (local.set $jb (i32.add (local.get $jb) (i32.const 64))))
        (else
          (call $block2 (local.get $src) (local.get $nIn) (local.get $w) (local.get $stride) (local.get $jb) (local.get $dst) (local.get $sparse))
          (local.set $jb (i32.add (local.get $jb) (i32.const 32)))))
      (br $jl))))

  ;; forward(desc, n, scratchA, scratchB): creatures 0..n-1; each scratch buffer holds the widest padded layer.
  (func (export "forward") (param $desc i32) (param $n i32) (param $sa i32) (param $sb i32)
    (local $c i32) (local $d i32) (local $l i32) (local $layers i32) (local $nIn i32) (local $nOut i32) (local $nPad i32)
    (local $w i32) (local $src i32) (local $dst i32) (local $o i32) (local $k i32)
    (block $cd (loop $cl
      (br_if $cd (i32.ge_u (local.get $c) (local.get $n)))
      (local.set $d (i32.add (local.get $desc) (i32.shl (local.get $c) (i32.const 6))))
      (local.set $w (i32.load (local.get $d)))
      (local.set $src (i32.load offset=4 (local.get $d)))
      (local.set $layers (i32.sub (i32.load offset=12 (local.get $d)) (i32.const 1)))
      (local.set $l (i32.const 0))
      (block $ld (loop $ll
        (br_if $ld (i32.ge_u (local.get $l) (local.get $layers)))
        (local.set $nIn (i32.load offset=16 (i32.add (local.get $d) (i32.shl (local.get $l) (i32.const 2)))))
        (local.set $nOut (i32.load offset=20 (i32.add (local.get $d) (i32.shl (local.get $l) (i32.const 2)))))
        (local.set $nPad (i32.and (i32.add (local.get $nOut) (i32.const 7)) (i32.const -8)))
        (local.set $dst (select (local.get $sb) (local.get $sa) (i32.and (local.get $l) (i32.const 1))))
        (call $layer (local.get $src) (local.get $nIn) (local.get $w) (local.get $nPad) (local.get $dst) (i32.eqz (local.get $l)))
        (local.set $w (i32.add (local.get $w) (i32.shl (i32.mul (i32.add (local.get $nIn) (i32.const 1)) (local.get $nPad)) (i32.const 2))))
        (local.set $src (local.get $dst))
        (local.set $l (i32.add (local.get $l) (i32.const 1)))
        (br $ll)))
      (local.set $o (i32.load offset=8 (local.get $d)))
      (local.set $k (i32.const 0))
      (block $kd (loop $kl
        (br_if $kd (i32.ge_u (local.get $k) (local.get $nOut)))
        (f32.store (i32.add (local.get $o) (i32.shl (local.get $k) (i32.const 2))) (f32.load (i32.add (local.get $src) (i32.shl (local.get $k) (i32.const 2)))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $kl)))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br $cl))))
)
