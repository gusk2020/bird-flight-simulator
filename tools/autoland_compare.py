import subprocess,sys,re,os
def run(f,mode,env):
    e=dict(os.environ); e.update(env)
    o=subprocess.run(["node",f,mode],capture_output=True,text=True,env=e,cwd="/home/user/bird-flight-simulator").stdout
    r={}
    for l in o.splitlines()[1:]:
        m=re.match(r"(\w+)\s+試行(\d+) 開始拒否(\d+) 開始許可(\d+) → 成功\(1.5秒保持\)(\d+) .* 衝突(\d+)",l)
        if m: r[m[1]]=(int(m[2]),int(m[3]),int(m[4]),int(m[5]),int(m[6]))
    return r
def table(title,mode,env):
    a=run("dist-test/autoland_diag_h6.cjs",mode,env); b=run("dist-test/autoland_diag.cjs",mode,env)
    print(f"### {title}  (mode={mode})")
    print("| 足場 | 試行 | 拒否 H6/H7 | 許可 H6/H7 | 成功(分子/許可) H6 | 成功(分子/許可) H7 | 衝突 H6→H7 |")
    print("|---|---|---|---|---|---|---|")
    tot=[0,0,0,0]
    for k in a:
        x,y=a[k],b[k]
        print(f"| {k} | {x[0]} | {x[1]}/{y[1]} | {x[2]}/{y[2]} | {x[3]}/{x[2]}={100*x[3]/max(1,x[2]):.1f}% | {y[3]}/{y[2]}={100*y[3]/max(1,y[2]):.1f}% | {x[4]}→{y[4]} |")
    print()
if __name__=="__main__":
    for t,mode,env in [("風なし(H6と同じ条件)","measure",{}),("風270°3m/s突風0.3(H6と同じ条件)","measure",{"APPWIND":"1"})]:
        table(t,mode,env)
