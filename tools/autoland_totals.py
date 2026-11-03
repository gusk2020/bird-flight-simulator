import subprocess,re,os,sys
def tot(f,mode,env):
    e=dict(os.environ); e.update(env)
    o=subprocess.run(["node",f,mode],capture_output=True,text=True,env=e,cwd="/home/user/bird-flight-simulator").stdout
    a=n=c=0
    for l in o.splitlines()[1:]:
        m=re.match(r"(\w+)\s+試行(\d+) 開始拒否(\d+) 開始許可(\d+) → 成功\(1.5秒保持\)(\d+) .* 衝突(\d+)",l)
        if m: a+=int(m[5]); n+=int(m[4]); c+=int(m[6])
    return a,n,c
conds=[("270/3","measure",{"APPWIND":"1"}),("90/5","holdout",{"APPWIND":"1","WINDDIR":"90","WINDSPD":"5","WINDGUST":"0.5"}),("180/4","holdout",{"APPWIND":"1","WINDDIR":"180","WINDSPD":"4","WINDGUST":"0.4"}),("270/6","holdout",{"APPWIND":"1","WINDDIR":"270","WINDSPD":"6","WINDGUST":"0.6"}),("calm","holdout",{})]
for name,f in [("H6","dist-test/autoland_diag_h6.cjs"),("H7 full","dist-test/autoland_diag.cjs"),("no air-flap/brake","dist-test/dv_noair.cjs"),("no gate","dist-test/dv_nogate.cjs"),("neither","dist-test/dv_none.cjs")]:
    print(f"{name:18}", " | ".join(f"{c[0]} {a}/{n} col{k}" for c in conds for a,n,k in [tot(f,c[1],c[2])]))
