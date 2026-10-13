# 上传说明

把一份**还没做兼容**的 mod 上传到本仓库的 [`incoming/`](incoming)。维护者会读你的说明、
判断原件里哪些部分有接口，改写成工坊包格式，通过校验后放进 [`packs/`](packs)。

> 已经**能装**的工坊包不要传到这里 —— 那种请直接提到 `packs/`（见 [`packs/README.md`](packs/README.md)）。
>
> **完全不会用？先看 [BEGINNER.md](BEGINNER.md)。** 那一份讲的是「怎么自己做出一个包」；
> 这份 UPLOAD.md 讲的是「怎么把别人的原件交上来」。

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
| 5 | **自带素材是哪来的** | 同人自制的？还是从游戏里解包的？**两者都收**，但解包的必须**如实写明**（见下面的素材口径） |

照着 [`incoming/SOURCE.template.md`](incoming/SOURCE.template.md) 抄一份填空最快。

---

## 二、怎么上传（三种方式，挑一种）

> **有上传站就不用看这一节了。** 本仓库自带一个上传站（[`site/`](site)）：在网页上填「mod 名 + 备注」、
> 选 zip、点上传即可，比下面三种都省事。部署与用法见 [`site/README.md`](site/README.md)。
> 站点会把包收进待审队列，维护者下载跑测试、审完名称与内容后上线。
>
> **两条路线现在是同一条口径**（业主 2026-10-12 改）：上传站对「疑似夹带官方素材」是**照收**（存进单独目录、
> 公开时明确标注）；**往本仓库里**（`incoming/` 与 `packs/`）也**照收**，条件是**标注清楚** ——
> 见下面第三节的清单与 [`SKILL.md`](SKILL.md) §14 的素材口径。**未标注才是问题**。

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
- [ ] 夹带了游戏素材（解包出的美术、音频、字体、数据导出物）的话，**已在 `SOURCE.md` 里如实写明**
      —— 那种**照收**，但要标注清楚：包内 `PROVENANCE.md` 写「含官方素材」+ 实测清点，站上备注也写明，
      并写清版权归鹰角网络 / Yostar、仅供非商业学习与个人娱乐（[`SKILL.md`](SKILL.md) §14 素材口径）。
      **未标注才是问题**
- [ ] 原作者明确**禁止再分发**的原件没有传上来
- [ ] 传的不是「已经能装的工坊包」（那种去 `packs/`）
- [ ] 传的**真的带功能**：不是 `documentation-only` / 只读参考 / 只放 JSON 与说明面板的东西
      —— 那种**不上架**，见 [`SKILL.md`](SKILL.md) §15.1；**但已经投上来的不「打回」，留在待审**：
      **记录与简介保留**，那是我们**做兼容包改写的依据**（打回会写下 `rejected`、离开待审队列）；
      会改对局结果的必须在说明里标注
- [ ] 没有改本仓库的其它东西（不要顺手改引擎源码或校验工具来「让它跑起来」）

---

## 四、接下来会发生什么

1. 维护者读 `SOURCE.md`，拿**未改动的引擎**当基准，逐文件测出原件到底改了什么
2. 分三堆：能做进包的（数据/界面/行为）· 没有接口的（如实写进说明）· 素材（**自制/授权的照收；
   解包出来的官方素材也照收，但按素材口径标注清楚**）
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

上传只是第一步。**格式、层、`api` 与 `game`、素材口径、署名与许可要求**都在
[`SKILL.md`](SKILL.md) —— 想自己动手改成包的话，先把它读完。
