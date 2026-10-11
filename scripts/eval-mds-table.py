# Regenerates MDS_TABLE in src/eval/stats.ts: the minimum detectable normal shift (in SD units, on a 0.2 grid) at
# which the exact two-sided Wilcoxon–Mann–Whitney test, n v n untied reps, gives p <= the threshold with B better in
# at least 80% of simulations. One row per (n, attainable p <= 0.05). Seeded, so a re-run prints the same table.
#
#   python3 scripts/eval-mds-table.py      # needs numpy; about 5 minutes
#
# Output (2026-10-12): 4 0.02857 3.0 | 5 0.00794 3.2 | 5 0.01587 2.8 | 5 0.03175 2.4 |
#                      6 0.00216 3.4 | 6 0.00433 3.0 | 6 0.00866 2.6 | 6 0.01515 2.4 | 6 0.02597 2.2 | 6 0.04113 2.0
import itertools, numpy as np
from fractions import Fraction
def pmap(n):
    N=2*n; E=Fraction(n*(N+1),2); W=[sum(c)+len(c) for c in itertools.combinations(range(N),n)]
    tot=len(W); dev=[abs(w-E) for w in W]
    return {w: sum(1 for d in dev if d>=abs(w-E))/tot for w in set(W)}, sorted(set(sum(1 for d in dev if d>=x)/tot for x in set(dev)))
rng=np.random.default_rng(20261012)
for n in (4,5,6):
    pm, ps = pmap(n); thr=[p for p in ps if p<=0.05+1e-12]
    E=n*(2*n+1)/2
    for t in thr:
        mds=None
        for step in range(1,41):
            d=step*0.2; hits=0; S=4000
            a=rng.normal(0,1,(S,n)); b=rng.normal(d,1,(S,n))
            allv=np.concatenate([a,b],1); ranks=allv.argsort(1).argsort(1)+1
            W=ranks[:,n:].sum(1)
            for w in W:
                if w>E and pm[int(w)]<=t+1e-12: hits+=1
            if hits/S>=0.8: mds=round(d,1); break
        print(n, f"{t:.5f}", mds)
