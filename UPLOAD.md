# 上传说明

把一份**还没做兼容**的 mod 上传到本仓库的 [`incoming/`](incoming)。维护者会读你的说明、
判断原件里哪些部分有接口，改写成工坊包格式，通过校验后放进 [`packs/`](packs)。

> 已经**能装**的工坊包不要传到这里 —— 那种请直接提到 `packs/`（见 [`packs/README.md`](packs/README.md)）。

---

## 一、要传什么

一个 mod 一个目录，**目录名就用 mod 的名字**：

```
incoming/
└── <mod 名字>/
    ├── SOURCE.md     ← 必需。照抄 incoming/SOURCE.template.md 填
    └── …             ← 原件里与该 mod 有关的文件：改动的文件、patch、zip、说明文档都行
```

### `SOURCE.md` 必须写清五件事

缺一件维护者就没法开工 —— **宁可写得啰嗦，也不要写「优化了平衡」这种没有信息量的话**。

| # | 写什么 | 说明 |
|---|---|---|
| 1 | **原件叫什么、从哪来** | 仓库 URL / 发布页 / 群文件截图都行，**要能追溯**。有版本号或日期就写上 |
| 2 | **原作者是谁** | 署名用。**原件没署名就写「原件未署名」** —— 不要留空，更不要自己填一个名字 |
| 3 | **原件的许可** | 有没有 LICENSE、允许什么、是否禁止再分发。没有就写「原件未声明许可」 |
| 4 | **它改了什么** | 尽量具体：改了哪些文件、哪些数据、哪些数值。做成一张表最好 |
| 5 | **自带素材是哪来的** | 同人自制的？还是从游戏里解包的？**后者不会被收录**（见下面的红线） |

照着 [`incoming/SOURCE.template.md`](incoming/SOURCE.template.md) 抄一份填空最快。

---

## 二、怎么上传（三种方式，挑一种）

### 方式 A · GitHub 网页（不装 git 的用这个）

1. 打开 https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods
2. 进 `incoming/` 目录 → **Add file ▾ → Create new file**
3. 文件名里**打斜杠就会自动建目录**，所以填：`incoming/<mod 名字>/SOURCE.md`
   - 内容照抄 [`incoming/SOURCE.template.md`](incoming/SOURCE.template.md) 填好五件事
4. 提交后回到 `incoming/<mod 名字>/` 目录 → **Add file ▾ → Upload files** → 把原件的文件拖进去
5. 页面底部 **Commit changes** —— 有写权限就直接进 main；没有就选 **Create a new branch and pull request**

> 也可以把整个 `<mod 名字>` 文件夹直接拖进 `incoming/` 页面（GitHub 支持拖文件夹上传），
> 但要确认里面已经有 `SOURCE.md`。

### 方式 B · git（熟手的用这个）

```bash
git clone https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods.git
cd Stronghold-Protocol-Forge-Mods
mkdir -p "incoming/<mod 名字>"
# 把原件放进去，照模板写 incoming/<mod 名字>/SOURCE.md
git add "incoming/<mod 名字>"
git commit -m "上传 <mod 名字>（来源：<URL>）"
git push            # 有写权限直接推 main；没有就开分支发 PR
```

### 方式 C · 只开一个 issue（手上只有链接的用这个）

如果原件在别的仓库/网盘，你只是想让维护者知道有这么个东西，开一个 issue 贴上去即可：
原件名称、来源 URL、原作者、许可、它大致改了什么。维护者会把它落到 `incoming/` 里。

---

## 三、上传前自己先过一遍这张清单

- [ ] 目录名是 mod 的名字，没套多余的层级
- [ ] `SOURCE.md` 五件事都写了，且**原始出处可追溯**
- [ ] **没有夹带任何游戏素材**（解包出的美术、音频、字体、数据导出物）
      —— 原件里夹着的话，只传它的**改动说明与代码/数据部分**，别连素材一起打包
- [ ] 原作者明确**禁止再分发**的原件没有传上来
- [ ] 传的不是「已经能装的工坊包」（那种去 `packs/`）
- [ ] 没有改本仓库的其它东西（不要顺手改引擎源码或校验工具来「让它跑起来」）

---

## 四、接下来会发生什么

1. 维护者读 `SOURCE.md`，拿**未改动的引擎**当基准，逐文件测出原件到底改了什么
2. 分三堆：能做进包的（数据/界面/行为）· 没有接口的（如实写进说明）· 素材（只留自制/授权的）
3. 改写成工坊包格式放进 `packs/`，署名与原件许可随包保留
4. 用引擎自己的装载器验一遍：

   ```bash
   node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
   ```

5. 通过之后 `packs/` 里就有它了；原件可以留在 `incoming/` 留档，也可以由维护者清掉

**不会发生的事**：不会为了让你传的东西「能装上」而改引擎、改校验，或把没验过的东西直接放进 `packs/`。
`incoming/` 里的包**装不上是正常的** —— 那正是它叫 incoming 的原因。

---

## 五、写包的完整规则

上传只是第一步。**格式、层、`api` 与 `game`、素材红线、署名与许可要求**都在
[`SKILL.md`](SKILL.md) —— 想自己动手改成包的话，先把它读完。
