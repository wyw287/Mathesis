# Canvas Artifact 契约

这份文档定义整个系统的中枢:**对话层、工具层、画布层、渲染层、状态层之间只通过这里定义的
数据结构通信**。渲染库可以换,模型可以换,provider 可以换;这份契约换了等于重写。

设计目标按优先级:

1. **可持久化** —— artifact 是学生能回看、能引用的对象,不是一次性的渲染结果
2. **可校验** —— 模型输出必须能被机器验证,校验失败要能降级而不是白屏
3. **可演进** —— 前端升级后,三个月前存下来的 artifact 仍然能打开
4. **有界上下文** —— 画布可以无限增长,塞给模型的 token 不能

---

## 1. 三个正交的分类

先把三组容易混淆的概念分开,后面所有设计都基于它们:

| 概念 | 含义 | 生命周期 |
|---|---|---|
| **Spec** | 纯数据,描述画什么。无逻辑、可序列化、可校验 | 持久化 |
| **Renderer** | 把 Spec 变成 DOM 的 React 组件。无状态 | 随代码版本走 |
| **Artifact** | Spec 在画布上的**实例**,带 id、版本、引用关系、用户操作产生的局部状态 | 持久化 |

关键约束:**Spec 里不允许出现函数**。这条是硬线。一旦 Spec 里能塞 `onUpdate` 回调,
它就不可序列化、不可校验、不可持久化,而且无法跨 session 恢复。所以文档里
`slider({ param, range, onUpdate })` 那个 `onUpdate` 必须去掉——滑块的行为是
**renderer 的职责**,不是 spec 的字段。滑块拖动产生的是 §5 定义的事件。

---

## 2. CanvasArtifact

```ts
interface CanvasArtifact<S extends ArtifactSpec = ArtifactSpec> {
  id: string;              // 稳定唯一 id,一经分配永不复用
  spec: S;                 // 纯数据,见 §3
  rev: number;             // 修订号,从 1 开始。edit 时 +1
  schemaVersion: number;   // Spec 结构本身的版本,见 §6
  origin: 'ai' | 'user';
  title: string;           // 人可读,用于对话引用("上一张图")
  createdAt: number;
  updatedAt: number;
}
```

`rev` 和 `schemaVersion` 是两件事,别混:

- `rev` 回答"这张图被改过几次"——用户改滑块、AI 改定义域,都会 +1
- `schemaVersion` 回答"这份 spec 是按哪一版契约写的"——只在前端不兼容升级时 +1

`title` 不是装饰。它是**上下文压缩的抓手**:塞给模型的永远只是
`{id, kind, title}` 的目录,不是完整 spec(§7)。

### title 从哪来:`label` 优先

每个 spec 都可以带一个 `label` —— 模型建卡时给这张卡起的**短名**:

```ts
interface ArtifactBase {
  label?: string;   // 「伴随矩阵求逆」「极限不存在的判据」
}
```

`title = clip(label) ?? 按内容自动派生`。`label` 在 `registry.parseSpec` 里统一收下,
不在各个 kind 的 parse 里 —— 它跟 kind 没有关系,而且这样新增 kind 自动就有。
每个 kind 的工具参数里也统一注入了这同一个字段(在 `tools/index.ts` 那一层)。

**为什么不让标题去装公式。** 卡片头部是一行,旁边还有类别徽章、id、修订号和删除
按钮跟它并排,`.artifact-title` 上还挂着 `text-overflow: ellipsis` —— 也就是说
超过 `TITLE_MAX`(24)之后它会在 CSS 那一层**再被省略一次**,省略的位置还取决于
窗口宽度。而把公式拍成纯文本本身就是有损的:`\frac{1}{2}` 变 `1/2`,矩阵变成
`1, 2, 3; 0, 1, 2`。卡片本体就在标题正下方,用 KaTeX 把它渲染得好好的 ——
标题去做那件事,只会做出一个更差的复制品。

所以分工是:**标题只说"这张卡是干什么的",内容交给卡片本体。** 想让标题"说完整"
的冲动,正确做法是让模型给个 `label`,而不是把上限调大。

标题里也**不再带类别前缀**(以前是 `推导：…`、`测验：…`)。类别由卡片头部的徽章
和目录里的 `kind` 字段表达,前缀只是白占字数,而长度直接是 token 开销。

---

## 3. Spec 家族

第一阶段只实现三种。`kind` 是判别字段。

### 3.1 plot2d

```ts
interface Plot2DSpec {
  kind: 'plot2d';
  view: { x: [number, number]; y?: [number, number] };  // y 省略则自动
  curves: Curve[];
  points?: PlotPoint[];
  params?: ParamSpec[];          // 滑块。拖动只改 §5 的运行时值,不改 spec
  annotations?: Annotation[];
  note?: string;                 // 一句话说明这张图要人注意什么
}
```

`Curve` 是联合类型,覆盖自学者真正会用的:

```ts
type Curve =
  | { type: 'explicit';   expr: string; domain?: [number, number]; label?: string; style?: LineStyle }
  | { type: 'parametric'; x: string; y: string; t: [number, number]; label?: string; style?: LineStyle }
  | { type: 'sequence';   expr: string; n: [number, number]; label?: string; style?: LineStyle }
  | { type: 'implicit';   eq: string; label?: string; style?: LineStyle }
  | { type: 'vectorField'; fx: string; fy: string; density?: number; scale?: 'fixed' | 'magnitude' }
```

前三种是"沿着 x 或 t 走一遍"就能采样的;后两种**没有这个前提** ——
`x^2+y^2=1` 里一个 x 对应两个 y,所以必须在视口上铺二维网格:
`implicit` 走 marching squares,`vectorField` 逐点取箭头。实现分两路
(`lib/math.ts` 与 `lib/field.ts`),渲染也分两路。

`expr` 是受限数学表达式,**不是 JS**。由 mathjs 解析,变量是 `x`(或 `t`/`n`),
外加 `params` 里声明的参数名。`^` 是幂运算。刻意不支持函数定义、赋值、多语句——
表达式里没有副作用,也就不需要沙箱。

`implicit` 和 `vectorField` 需要数值网格采样,和 `explicit` 不是一个量级的渲染成本,
所以它们必须在 spec 里显式区分,renderer 才能分别做降采样。

### 3.2 derivation

这是高阶自学的**主战场**,也是和"聊天机器人贴公式"最本质的区别。

```ts
interface DerivationSpec {
  kind: 'derivation';
  statement?: string;        // 要证/要推的命题 (LaTeX)
  given?: string[];          // 前提 (LaTeX)
  steps: DerivationStep[];
  collapsed?: boolean;       // 初始是否折叠
}

interface DerivationStep {
  id: string;
  latex: string;             // 这一步的式子 (LaTeX)
  reason: string;            // 理由:用了哪条定义/定理/规则,一句话(数学符号用 $...$)
  from?: string[];           // 依赖的 step id,构成 DAG
  gap?: GapKind;             // 见下,整个设计里最重要的一个字段
  detail?: string;           // 展开后显示的细节 (Markdown,公式用 $...$)
}

type GapKind =
  | 'technical'    // 纯技术性步骤,略过不影响理解
  | 'substantive'  // 本质的一步,值得停下来看
  | 'unjustified'  // 这里我省略了 / 我没证 —— 诚实标记
  | 'assumption';  // 这一步引入了一个假设
```

**`gap` 是这个产品区别于普通 AI 讲题的地方。** 通用模型讲证明的通病是把所有步骤
等权排列,学生看不出哪一步是"套定义",哪一步是"整个证明真正干活的地方",
也看不出模型在哪里悄悄跳过了东西。强制模型标注 `gap`,等于强制它对自己的讲解做
元认知。`unjustified` 尤其重要:允许模型说"这一步需要 Zorn 引理,这里不展开",
比编一个假证明有价值得多。

**`reason` 和 `detail` 是散文,但里面会有公式。** 模型写理由时很自然会顺手把符号
写进去(`欧姆定律给出支路电流 g_{ij}(v_i - v_j)`)。这两个字段都必须过渲染器,
不能直接打印:直接打印出来的就是带下划线和花括号的原始 LaTeX。`detail` 走
Markdown;`reason` 走 `MathText` —— 含 `$` 时按 Markdown 处理,否则整句当公式。
工具描述里明说了要用 `$` 括起来,因为那样走 Markdown 路径、中文之间的空格会被保留,
而"整句当公式"那条兜底路径里 KaTeX 会按数学模式吃掉空格。

### 逐步核对(StepCheck)

`gap` 是**模型自报**的 —— 它说这一步是"套定义",学生只能信。对自学者来说,
"这一步到底对不对"恰恰是他没法自己验证的那件事,而这正是学习工具和参考书
之间的差别。

所以每一步还可以带一个**机器可读形式**,交给 CAS 核对:

```ts
check?: {
  expr: string;                       // 本步的式子,普通数学语法,不是 LaTeX
  against?: string;                   // 与哪一步比,默认上一步
  relation?: 'equivalent' | 'derivativeOf';
  vars?: string[];                    // 自由变量,默认 ['x']
}
```

**为什么必须由模型额外提供 `expr`,而不是从 `latex` 反解:** LaTeX 是排版语言,
不是语义。把 `rac{d}{dx}x^2` 反解成表达式是出了名的不可靠。一个公式要能被核对,
就必须同时有一个 CAS 读得懂的形式。

引擎是 **nerdamer**(纯 JS,动态加载,不进首屏)。选它而不是 SymPy/Pyodide 的理由
是**可测**:投影和化简都是纯计算,能在 node 里写断言;而 10 MB 的 WASM 在无头
环境里一行都验证不了。

判定有三态,而且**三态是实测逼出来的**:

| 情形 | 结论 |
|---|---|
| `simplify(expr - against) === 0` | ✓ 机器核对通过 |
| 非零,但数值抽样处处一致 | ~ **化简不出来**(弱证据) |
| 非零,且抽样点上算出不一致 | ✗ **这一步是错的** |

中间那一条不能省。实测发现 nerdamer 和 algebrite 都认不出
`sin(2x) = 2sin(x)cos(x)` —— 把"非零"直接当成"错了",那一步会被冤枉。
**冤枉一个正确的步骤,比漏报一个错误步骤伤害大得多。**

第三行是这套机制最有价值的产出:它让系统第一次能**指出模型讲错了**,
而不是让学生去信任它。

### 3.3 quiz

先留最小可用形态,不做花哨题型。

```ts
interface QuizSpec {
  kind: 'quiz';
  question: string;          // LaTeX 或 Markdown
  choices?: { id: string; text: string }[];   // 有则单选,无则开放作答
  answerKey?: string[];      // 不下发给渲染层,仅作答后用于本地判分
  explanation?: string;      // 答后展示
  freeformPlaceholder?: string;
}
```

`answerKey` 会随 artifact 一起持久化在本地——自用场景可以接受,但渲染层
**在用户作答前不得把它渲染进 DOM**。这不是安全问题,是别让学生 F12 一下就看见答案。

### 3.4 counterexample

反例工作台。高阶数学里「去掉这个条件还成立吗」是理解定理的主要方式,
而反例是这个过程的产物。

```ts
interface CounterexampleSpec {
  kind: 'counterexample';
  claim: string;                    // 要反驳的命题 (LaTeX)
  plot: Plot2DSpec;                 // 候选对象,复用 plot2d
  hypotheses: CounterexampleCheck[]; // 反例必须满足的前提
  conclusion: CounterexampleCheck;   // 命题的结论,写成「结论不成立」
  found?: string;                    // 全部满足时告诉学生他找到了什么
}
```

这是**组合**而不是新画法:候选对象本来就是要画出来的函数,所以 `plot` 直接嵌一个
`Plot2DSpec`,解析和渲染全都复用,参数也是同一套。真正新增的只有条件检查那一层。

条件分三种**可信度**,这是这个 kind 最重要的设计:

| kind | 含义 | 显示 |
|---|---|---|
| `numeric` | 把参数代进表达式算一个值再比对 | ✓ / ✗ |
| `sampled` | 在区间上采样判性质(恒正、变号、单调) | ✓ / ✗ |
| `asserted` | 模型声称成立,**系统验不了** | **~** |

**`asserted` 必须存在,而且必须显示成第三种样子。** 有些前提(连续、可导、
一致收敛)在数值上根本没法验证;把它们和算出来的挤成同一个对勾,等于给学生
一个**假的确定性**——那比不做检查更糟。判定时 `asserted` 算作满足(否则一条
「处处连续」会让任何反例都无法成立),但会被**单独计数**,界面必须把它说出来。

这和 §3.2 的 `gap` 是同一个思路:**让"我验过"和"我说是"分得开。**

### 3.5 compare

并排对比。正例 vs 反例、f vs f′、同一函数在不同参数下的样子。

```ts
interface CompareSpec {
  kind: 'compare';
  items: CompareItem[];   // 恰好 2 或 3 格
  claim?: string;         // 正在讨论的命题
  note?: string;          // 要学生注意的对比点 —— 这句话才是对比的意义
  // CompareItem = { label: string; spec: Plot2DSpec | DerivationSpec }
}
```

**两边共享一套参数。** 各格用同一个 `artifactId`,于是天然共用一份参数作用域:
拖一个滑块两边同时变。这正是对比最有用的形态 —— 同一个 `a` 对两个函数各有什么
影响,一眼就能看出来。各自独立反而丢掉了这个。

`note` 在工具 schema 里是必填的。没有它,并排只是两张图 —— **学生不会自己知道
该看哪里**。这一条不做成硬校验(模型偶尔会漏),但渲染时放在图**上面**:
它是"请留意哪里"的提示,不是看完之后的结论。

能并排的对象是**显式枚举**的(`plot2d` 和 `derivation`),不是任意 kind。
这不需要注册表 —— 直接 import 那两个 kind 的解析器和渲染器即可,也就避开了
`compare → registry → compare` 的环。枚举本身也是好事:"什么适合并排看"
本来就有答案。

### 3.6 plot3d

三维曲面,**可以拖着转**。

```ts
type Surface3D =
  | { type: 'height';     expr: string; over: { x: [number, number]; y: [number, number] } }
  | { type: 'parametric'; x: string; y: string; z: string;
      over: { u: [number, number]; v: [number, number] } };

interface Plot3DSpec {
  kind: 'plot3d';
  surface: Surface3D;
  params?: ParamSpec[];     // 和 plot2d 同一套
  view?: { yaw?: number; pitch?: number };  // 初始朝向,单位度
  resolution?: number;      // 网格密度,默认 44
  wireframe?: boolean;      // 默认开 —— 曲面的拓扑靠它才读得出来
}
```

只做这两种。**隐式曲面 F(x,y,z)=0 刻意不做** —— 那需要 marching cubes
(256 种情形、约 15 种歧义,而且经典情形表是已知有洞的)。与其做一个会撕出洞
的版本,不如不做,并在工具描述里写清楚,免得模型用别的参数硬凑出形状错误的图。

**渲染是手写 canvas,不引 three.js。** 两个理由:项目到现在只有四个依赖;
以及**这一层能测** —— 投影点的位置、旋转基的正交性、自动装框后所有点是否落在
视口内,都是能写断言的,而 WebGL 在无头环境里一行都验证不了。

代价是 painter's algorithm,没有深度缓冲,自相遮挡的曲面可能有伪影。对函数图像
和参数曲面按面片平均深度排序在实践中够用。

配色按高度:跨过零点时用**发散配色**(负蓝正红),因为马鞍面、极值这类图形
最需要一眼看出零点的位置;不跨零点时用顺序配色 —— 对 `z = x² + y²` 用发散
配色会暗示一个并不存在的零点。

### 3.7 linear

2×2 线性变换的几何视图。线代里最难用文字讲清的部分是**矩阵到底对空间做了什么**。

```ts
interface LinearSpec {
  kind: 'linear';
  /** 2×2 矩阵,按行:[["a","b"],["c","d"]] 表示 [a b; c d]。元素是**表达式**。 */
  matrix: [[string, string], [string, string]];
  params?: ParamSpec[];
  view?: { x: [number, number]; y: [number, number] };
  /** 可选探测向量,同时画 v 和 Av */
  probe?: { x: string; y: string; label?: string };
  note?: string;
}
```

**模型只写矩阵,其余全由渲染器算。** 变换后的网格、单位正方形的像、行列式、
特征方向 —— 让模型自己算的话全是它容易写错的地方,而且**写错了学生看不出来**。
这和 §3.4 反例工作台的分工是同一条原则。

矩阵元素是**表达式**而不是数字,于是每个都能挂滑块 —— 拖一下就看见平面被扭成
什么样,那是这个 kind 几乎全部的价值。

三处几何结果是系统算的,也是这个视图真正的教学点:

| | 意义 |
|---|---|
| 网格变形 | 变换到底做了什么 |
| 单位正方形的像,面积 = `\|det\|` | 行列式是面积的缩放倍数;为负表示翻转定向 |
| 特征方向 | 方向不被改变的直线。**判别式小于零时不画线** —— 那是含旋转的变换,平面上没有任何方向不变,硬凑一条会教错东西 |

两个退化情形单独处理,因为它们是教学要点而不是边界情况:

- `det = 0` → 界面明说「整个平面被压到一条线(或一个点)上,不可逆」
- `A − λI` 是零矩阵(纯缩放)→ 界面明说「**所有**方向都是特征方向」。
  只画一条线会让学生以为只有那一个方向不变

另一个不那么显眼但会毁掉整个视图的细节:**默认视野要跟着矩阵撑开**。
矩阵是 `[[10,0],[0,10]]` 时单位正方形的像在 `(10,10)`,写死 `[-3,3]²`
学生就什么都看不见。撑开用的是**初始参数**下的矩阵 —— 拖滑块时视野必须固定,
否则学生看到的是"图形没变、视野在变",那正好丢掉了要展示的东西。

### 3.8 diagram

流程 / 逻辑图。

```ts
type DiagramRole = 'plain' | 'given' | 'key' | 'conclusion';

interface DiagramSpec {
  kind: 'diagram';
  nodes: { id: string; label: string; role?: DiagramRole }[];
  edges: { from: string; to: string; label?: string }[];
  direction?: 'down' | 'right';
  note?: string;
}
```

**和 §3.2 `derivation` 的分工要先说清**,否则会被用错:

| | 形状 | 回答的问题 |
|---|---|---|
| `derivation` | 线性步骤链,每步带理由、可被机器核对 | 这个推导怎么走 |
| `diagram` | 有分支和汇合的图 | 谁依赖谁、分几种情况 |

用 `diagram` 画一条直线推导,学生得到的是本可以用推导讲清楚、却画成一张关系网的东西。
所以这条写在了工具描述的最前面。

`role` 是这个 kind 的教学价值所在:一张所有节点长得一样的图只说明了"谁连着谁",
说不出"谁是要紧的"。这和 §3.2 的 `gap`、§3.4 的三种可信度是同一条思路。

#### 布局必须自动

**不能让模型给坐标。** 它看不见自己排出来的东西,结果是一张重叠成团的图 ——
而重叠的图比没有图更糟:学生会以为是自己没看懂。

`lib/graph-layout.ts` 做分层布局(断环 → 最长路径分层 → 重心法排序 → 居中),
三层全是纯函数,所以可测。主要盯三条不变量:每条边**严格向前跨层**、同层不重叠、
有环时**如实报告**忽略了哪几条。

最后一条是刻意的:**环形关系在教学里很常见**(`A ⟺ B` 是双向的、证明之间互相引用),
分层布局画不了它们。与其画一张错的,不如在图上明确标出"这几条没画进去"。

节点上的 `role` 也顺带解决了一个问题:**点击节点可以追问** —— 流程图是死的,
而画布是活的。复用已有的 `select` 事件(`target` 填节点 id),不需要新增协议。

### 3.9 matrix

和 §3.7 的 `linear` 是**同一件事的两面**,不是重复:

- `linear` 是「矩阵对空间做了什么」—— 2×2 的几何:网格怎么扭、面积怎么变、特征方向
- `matrix` 是「矩阵本身是什么」—— 任意尺寸的行列、乘法、转置、逆

```ts
interface MatrixSpec {
  kind: 'matrix';
  rows: string[][];            // 主矩阵,按行。元素是表达式,可引用 params
  params?: ParamSpec[];
  multiplyBy?: string[][];     // 再给一个矩阵 → 画出 A·B 并逐步演示
  focus?: [number, number];    // 开场聚焦哪一格,默认 [0,0]
  note?: string;
}
```

**它补上了什么。** 在此之前矩阵只能作为 `linear` 面板里的一小块、或者 `derivation`
里的一串 LaTeX 出现 —— **不是一个可以被引用的对象**:模型没法说「看 @a3 的第 2 行」,
学生也没法点。现在可以了。

**行 × 列的过程是这张卡的主要价值。** 矩阵乘法那个「行乘列」是从文字上最难建立
直觉的一步,所以它被展开成一串:

```
第 1 行 × 第 2 列
3×6 + 4×8 = 18 + 32 = 50
```

**交互是点格子**:点 A 的格子选中那一**行**,点 B 的格子选中那一**列**,
点结果矩阵的格子选中那一格。复用已有的 `select` 事件,不新增协议。
`select` 刻意**不进**交互计数 —— 那是刻意的设计(见 §7):点一下说明不了
「扫一眼」还是「认真看」,拿它当教学信号会误导。

**派生量全由代码算**(`det` / `Aᵀ` / `A⁻¹`),和 `linear` 同一条规矩:模型只写元素。
判别式、逆矩阵这类东西让模型自己算,是它容易出错、而学生看不出来的地方 ——
**逆矩阵画出来就是个矩阵,肉眼看不出它错在哪**。所以 `lib/matrixn.ts` 那一层
有独立的 node 自检,核心不变量是 `A·A⁻¹ = I`(随机扫几百个矩阵)。

不可逆时明说「不存在」而不是给一个假矩阵,`det = 0` 时指出「不可逆」——
那也是**要讲给学生听的情形之一**,不是错误。

尺寸上限 6×6:画布上放不下更大的,也不该为它跑 O(n³)。

---

## 4. 表达力分层:Tier 1 与 Tier 2

固定 schema 覆盖不了所有教学需求(`"把这张图变成动画"` 就不是任何一个 schema 能表达的)。
所以契约里显式留一个逃生舱口:

```ts
interface HtmlSpec {
  kind: 'html';
  html: string;        // 自包含 HTML,允许内联 <script>
  height?: number;
  capabilities: string[];  // 声明它会发哪些事件,见 §5
}
```

| | Tier 1 (声明式 spec) | Tier 2 (html) |
|---|---|---|
| 表达力 | 封顶 | 无上限 |
| 可校验 | 是 | 否 |
| 可交互 | 是,原生 | 靠 postMessage,要自己写 |
| 可引用/可编辑 | 是 | 只能整体替换 |
| 安全 | 无需沙箱 | 必须 iframe sandbox |

**策略:Tier 1 是默认路径,Tier 2 是逃生舱口。** 系统提示词里明确要求模型
"优先使用 plot2d / derivation / quiz;只有在这些确实表达不了时才用 html"。
Tier 2 一律跑在 `<iframe sandbox="allow-scripts">` 里,通过 postMessage 通信——
注意**不能**加 `allow-same-origin`,否则沙箱形同虚设。

---

## 5. 事件:画布 → 对话

这是文档里完全缺失的一环。没有它,"点这一步不懂"和"拖完滑块让 AI 看"就无从实现。

```ts
type CanvasEvent =
  | { type: 'paramChange';  artifactId: string; param: string; value: number }
  | { type: 'pointDrag';    artifactId: string; point: string; xy: [number, number] }
  | { type: 'select';       artifactId: string; target?: string }
  | { type: 'stepConfused'; artifactId: string; stepId: string }
  | { type: 'stepExpand';   artifactId: string; stepId: string }
  | { type: 'answer';       artifactId: string; response: { choice?: string; text?: string } }
  | { type: 'viewport';     artifactId: string; view: { x: [number, number]; y: [number, number] } }
  | { type: 'remove';       artifactId: string; title: string };
```

`remove` 带 `title` 是个例外:别的字段都能事后回 store 查,这个查不到 ——
事件真正被读到时 artifact 已经不在了。

它是补一个结构性不对称。创建和修改都走工具调用,模型能在工具结果里看到;
而删除走 UI 按钮直接改 store,曾经是**唯一一条对模型完全不可见的变更**。
后果是模型下一轮只看到目录里少了一项,分不清"被删了"和"从没存在过"。

两条规则:

1. **高频事件必须去抖,且分两档。** `paramChange` / `viewport` 在拖动过程中
   只更新本地渲染(零延迟),松手后才聚合成一条事件。否则每拖一像素发一次请求,
   既烧钱又卡。
2. **不是每个事件都要发给模型。** 事件先落到 session 的 `pendingEvents`,由
   前端按策略决定何时、以何种措辞并入下一条用户消息。拖滑块这类操作常常
   不需要 AI 介入——学生只是想自己看看。

`stepConfused` 是唯一一个**必须立即触发模型调用**的事件。它是学生的求救信号。

---

## 6. 版本与迁移

```ts
const CURRENT_SCHEMA_VERSION = 1;

// 每加入一个 schemaVersion,就在这里追加一个迁移函数
type Migration = (spec: any) => any;
const MIGRATIONS: Record<number, Migration> = {
  // 1: (spec) => ({ ...spec, newField: default })
};
```

加载本地的 artifact 时,若 `schemaVersion < CURRENT_SCHEMA_VERSION`,沿链依次迁移;
若渲染器遇到不认识的 `kind`,渲染成一张"此内容需要更新版本"的占位卡,
**不能崩溃,也不能静默丢弃**——学生三个月前存的推导不能因为一次前端升级就消失。

---

## 7. 上下文策略

画布无限增长,上下文有限。这是整个系统最容易在"用了一周之后"垮掉的地方。

**永远不进上下文的东西:** 完整 spec、渲染层状态、滑块当前值、用户拖动历史。

**每轮进上下文的:** 一个 artifact 目录,每项一行,后面可以带一段**交互标注**:

```
[a1] plot2d   sin(1/x) 在 0 附近的行为  · 拖过 12 次参数
[a2] derivation  ε-δ 定义的等价性  步骤5 [s1:technical s4:substantive]  · s4 标记不懂
[a3] quiz    极限存在性判断
```

交互标注是模型**唯一能"看到学习者"的地方**。只有目录能让它知道学生拖过几次滑块、
标记过哪一步不懂、哪张测验还没做 —— 没有这些,"主动引导"就只能被动响应文字,
诊断、脚手架、节奏控制、主动出题全都无从谈起。

只在真有过交互时才标注。没标注的含义是"没做过交互操作",**不等于"没看过"** ——
这个区别写进了系统提示词,免得模型把扫一眼当成没兴趣。

刻意只记录**已经发生的事实**(拖过几次、点开过哪一步),不推断掌握度:
掌握度是需要验证的模型,而"这一步被点开过三次"是个能直接用的事实。

⚠️ 目录会随卡片数增长。**每个会话各自一份画布**正是为了兜住这件事:
换一个话题就换一份干净的目录,而不必在一个无限变长的列表里找东西。
会话内部的增长仍然存在,真到五十张卡片那一步需要分组或分页,
不是加字段能解决的。

**按需取用:** 模型需要看具体内容时,调用 `readArtifact(id)`。
要修改已有的图时,调用 `editArtifact(id, patch)`,而不是重新生成一张。

这条设计有个直接推论:**生成 artifact 的工具调用,返回给模型的只是
`{id, kind, title}`,不是它自己刚写的 spec。** 模型刚写的东西没必要回灌给它自己。
一张 300 行的 spec 如果每轮都回灌,聊十轮就爆了。

---

## 8. 工具接口

```ts
interface TeachingTool<Args = any, S extends ArtifactSpec = ArtifactSpec> {
  name: string;
  description: string;
  parameters: JSONSchema;              // 送给模型的 JSON Schema
  validate(args: unknown): Args;       // 运行时校验,失败抛带说明的错
  execute(args: Args, ctx: ToolContext): Promise<ToolResult<S>>;
}

interface ToolContext {
  artifacts: ArtifactIndexEntry[];     // 目录,不是全部内容
  focus?: string;                      // 当前聚焦的 artifact id
  readArtifact(id: string): CanvasArtifact | undefined;
}

interface ToolResult<S> {
  artifact?: S;                        // 产出新 artifact
  patch?: { id: string; patch: Partial<CanvasArtifact> };
  message: string;                     // 回给模型的一句话,不是 spec
}
```

**`validate` 必须真校验,不能靠类型断言。** 模型的输出是不可信输入,和用户输入
同级。校验失败时的正确行为是:把校验错误作为 tool result 回给模型让它重试一次,
第二次再失败就降级成文字解释。这条降级链是"第三方中转不支持工具调用"时的
兜底方案的一半。

---

## 9. 第一阶段的范围

**做:** `plot2d`(仅 explicit / parametric / sequence)、`derivation`、
`quiz`、`editArtifact`、`readArtifact`、BYOK 设置、事件回传(仅 `stepConfused`)。

**已补上(原属推迟清单):** `implicit` 和 `vectorField`。当初推迟的理由是
「数值采样是独立课题」—— 确实如此,但课题本身不长:marching squares 加逐点箭头,
一百多行,单独成 `lib/field.ts` 就够了。

**3D 只做了一部分:** 高度图和参数曲面做了(§3.6),隐式曲面和三維向量场没做
—— 前者需要 marching cubes,是独立课题。

**不做:** `html`(Tier 2)、Pyodide/SymPy、动画、状态建模、Manim、Lean。

SymPy 推迟不是因为它不重要,而是因为**符号计算在第二阶段才能发挥价值**——
它真正的用途是"验证模型给的这一步推导对不对",那需要先有推导渲染器和
可信的表达式交换格式。顺序反了会白做。

---

## 10. 扩展:新增一个 kind

代码是这样组织的:每种 artifact 的**全部东西**都在 `src/kinds/<kind>/` 一个目录里 ——
spec 校验、标题生成、渲染器、教学工具。

```
src/kinds/
├── module.ts        KindModule 接口(框架契约)
├── registry.ts      显式列表 + 派生的 parseSpec / titleFor / 迁移 + 完整性断言
├── plot2d/          index.tsx(校验 + 标题 + 工具)、Plot2D.tsx(渲染器)、palette.ts
├── derivation/      index.ts、Derivation.tsx
├── quiz/            index.ts、Quiz.tsx
└── html/            index.ts、HtmlBlock.tsx
```

所以新增一种 artifact 只需要:

| # | 做什么 | 漏了会怎样 |
|---|---|---|
| 1 | 在 `types/artifact.ts` 的 `ArtifactSpec` 联合里加上新 Spec 类型 | 后面都用不了这个类型 |
| 2 | 新写 `src/kinds/<kind>/`,导出一个 `KindModule` | —— |
| 3 | 在 `kinds/registry.ts` 的 `KIND_MODULES` 里加一行 | **编译报错**,指向那一行 |

**`components/ArtifactCard.tsx`、`store/session.ts`、`tools/index.ts` 一行都不用动。**
前两个查注册表分派,第三个从注册表组装工具列表 —— 它们都不认识任何具体 kind。

### 为什么是显式列表,而不是自动发现

自注册(`import.meta.glob` 或模块副作用)看起来更省事,但它和穷尽性检查在根本上是对立的:

- tagged union 的全部价值,来自编译器**知道全部成员**
- 自注册的意义,是编译器**不知道**有什么

想同时要两者,只能靠 declaration merging 补类型。而类型增强(编译期,文件在 src/ 里就生效)
和运行时注册(副作用,被 import 才生效)是**两套独立机制** —— 一个文件完全可以
"类型上存在、运行时不存在",编译器对此完全沉默。后果是:TS 认为某个 kind 合法、
`parseSpec` 也放行,画布上却是一张空白卡片,没有任何线索。

更本质地说:想在运行时校验"类型与运行时是否一致",必须在运行时**枚举类型的成员**。
而运行时拿不到类型,只能靠一个显式列表 —— **那个列表,就是这里省不掉的那一行。**

### 完整性断言

`registry.ts` 里有一行:

```ts
type RegisteredKind = (typeof KIND_MODULES)[number]['kind'];
type MissingFromRegistry = Exclude<ArtifactKind, RegisteredKind>;
export const REGISTRY_IS_COMPLETE: MissingFromRegistry extends never ? true : false = true;
```

少注册一个 kind 时,`MissingFromRegistry` 会变成那个 kind(而不是 `never`),
`= true` 那行立刻报错。**这是整个链路上唯一的一处检查,却覆盖了全部消费方** ——
解析、标题、渲染、工具都是从同一个列表派生的。

### 怎么验证自己改对了

临时往 `ArtifactSpec` 联合里塞一个假的 kind,跑 `tsc --noEmit`。
应该**恰好报一处错**,而且指向 `kinds/registry.ts` 的 `REGISTRY_IS_COMPLETE`。

```
kinds/registry.ts(44,14): error TS2322: Type 'true' is not assignable to type 'false'.
```

- 报零处 → 断言被删了或写错了,整个检查失效
- 报多处 → 说明有地方绕过了注册表,在做 kind 特判

验证完记得还原。

### 唯一没有编译期保证的地方

新 kind 必须**有人产出它** —— 也就是要有工具,否则模型永远造不出来。
这属于数据流,类型系统管不了。

注意 `KindModule.tool` 是可选的:`html` 就没有工具。它是 Tier 2 逃生舱口
(见 §4),只在 plot2d / derivation / quiz 确实表达不了时才该出现。给它一个
一等公民的工具,模型会当成常规选项来用,而 Tier 2 的 spec 不可校验、不可引用、
不可局部编辑。降级路径下模型仍然可以产出它。

### 判断该不该新增 kind

先问一句:能不能用现有的 kind 表达?

- 想画另一种图 → 给 `plot2d` 加一个 `Curve` 变体。`Curve` 本身就是联合,
  扩展它比新增 kind 便宜得多,而且完全不用碰注册表。
- 想加一种题型 → 优先扩展 `QuizSpec`。
- 只有当**渲染方式、交互方式、生命周期都不同**时才新增 kind。`html` 之所以
  独立成 kind,是因为它要跑在 iframe 沙箱里、交互要走 postMessage,
  和其余三个没有共性。

每新增一个 kind,都要能渲染**所有历史版本存下来的** kind(见 §6)。这是契约演进的
真实成本,不是免费的。
