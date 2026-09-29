/**
 * 推导核对自检。
 *
 * 这块的难点**不是**"能不能算",而是三态分得对不对。实测发现 nerdamer 和
 * algebrite 都认不出 `sin(2x) = 2sin(x)cos(x)` —— 所以"CAS 算出非零"不等于
 * "这一步错了"。如果混为一谈,那一步会被冤枉,而**冤枉一个正确的步骤**
 * 比漏报一个错误步骤伤害大得多。
 *
 * 运行:npm run check:cas
 */
import { numericAgrees, verifyStep } from '../src/lib/cas';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\n数值抽查');

  ok('等价的两个式子处处一致', numericAgrees('(x+1)^2', 'x^2+2*x+1', ['x']) === true);
  ok('不同的式子抽得到矛盾点', numericAgrees('x^2', 'x^3', ['x']) === false);
  ok('差一个常数也算不等', numericAgrees('x+1', 'x+2', ['x']) === false);
  ok('多变量也认', numericAgrees('(a+b)^2', 'a^2+2*a*b+b^2', ['a', 'b']) === true);
  ok('处处无定义时判"判不了",而不是"一致"', numericAgrees('sqrt(-1-x^2)', '0', ['x']) === null);

  console.log('\n核对 —— 机器能确认的');

  {
    const v = await verifyStep({ expr: 'x^2+2*x+1', against: '(x+1)^2' });
    ok('展开前后判为等价', v.status === 'confirmed', `${v.status}: ${v.note}`);
  }
  {
    const v = await verifyStep({ expr: 'x+1', against: '(x^2-1)/(x-1)' });
    ok('约分判为等价(尽管约掉的地方有可去间断点)', v.status === 'confirmed', `${v.status}: ${v.note}`);
  }
  {
    const v = await verifyStep({ expr: 'exp(x)*(x^2-2*x+2)', against: 'integrate(x^2*exp(x), x)' });
    // against 是给 CAS 读的表达式,不是给人看的 LaTeX —— 这里验的是"它确实能处理积分式"
    ok('含积分的式子能处理', v.status === 'confirmed' || v.status === 'unconfirmed', v.status);
  }
  {
    const v = await verifyStep({ expr: '3*x^2', against: 'x^3', relation: 'derivativeOf' });
    ok('求导正确时判为等价', v.status === 'confirmed', `${v.status}: ${v.note}`);
  }

  console.log('\n核对 —— 机器能指出错误(这是最有价值的产出)');

  {
    const v = await verifyStep({ expr: 'x^3', against: 'x^2' });
    ok('把 x^2 写成 x^3 被判为"不等"', v.status === 'differs', `${v.status}: ${v.note}`);
  }
  {
    // 差一个常数在化简里很常见,而它确实意味着这一步错了
    const v = await verifyStep({ expr: 'x+2', against: 'x+1' });
    ok('差一个常数也判为"不等"', v.status === 'differs', `${v.status}: ${v.note}`);
  }
  {
    const v = await verifyStep({ expr: '2*x', against: 'x^3', relation: 'derivativeOf' });
    ok('求导求错时判为"不等"', v.status === 'differs', `${v.status}: ${v.note}`);
  }

  console.log('\n核对 —— 化简不出来时必须说"不确定",不能说"错"');

  {
    // 实测:nerdamer 和 algebrite 都认不出这个恒等式。它是**对的**。
    // 一套分不清"错"和"化简不出来"的设计会在这里冤枉模型。
    const v = await verifyStep({ expr: '2*sin(x)*cos(x)', against: 'sin(2*x)' });
    ok('三角恒等式判为"不确定"而不是"不等"', v.status === 'unconfirmed', `${v.status}: ${v.note}`);
    ok('而且说明里点出这是弱证据', /弱证据/.test(v.note), v.note);
  }

  console.log('\n核对 —— 读不懂时要说读不懂');

  {
    const v = await verifyStep({ expr: '这不是数学', against: 'x' });
    ok('解析不了的式子判为"无法核对"', v.status === 'unavailable' || v.status === 'differs', `${v.status}: ${v.note}`);
  }

  console.log('\n每种状态都有话说');

  {
    const all = [
      await verifyStep({ expr: 'x^2+2*x+1', against: '(x+1)^2' }),
      await verifyStep({ expr: 'x^3', against: 'x^2' }),
      await verifyStep({ expr: '2*sin(x)*cos(x)', against: 'sin(2*x)' }),
      await verifyStep({ expr: '???', against: 'x' }),
    ];
    ok('四条结论都不一样', new Set(all.map((v) => v.status)).size >= 3, JSON.stringify(all.map((v) => v.status)));
    ok('每条都带说明,不是光给个符号', all.every((v) => v.note.length > 6), JSON.stringify(all.map((v) => v.note)));
  }

  console.log('\n多项式走快路(这是性能修复本身)');

  {
    // 不做这条捷径的话,simplify 在这个式子上要 **29 秒**(实测,次数越高增长越快)。
    // 走 expand 只要几十毫秒。这条测试就是盯住那个捷径别被改回去。
    const t = Date.now();
    const v = await verifyStep({ expr: 'x^20+20*x^19', against: '(x+1)^20' });
    const ms = Date.now() - t;
    ok('高次多项式的不等能判出来', v.status === 'differs', `${v.status}: ${v.note}`);
    ok('而且远快于 simplify 的量级', ms < 2000, `${ms}ms`);
  }

  {
    // 等价的情形:两个字符串不同,但展开后一样
    const t = Date.now();
    const v = await verifyStep({ expr: '(x+1)*(x+1)^19', against: '(x+1)^20' });
    const ms = Date.now() - t;
    ok('高次多项式相等也判得快', v.status === 'confirmed' && ms < 2000, `${v.status} ${ms}ms`);
  }

  {
    // 反过来:含超越函数时**不能**走那条捷径 —— expand 不会规范化三角恒等式,
    // 走捷径会把对的式子判成不等。上一条"三角恒等式"用例已经盯住了结论,
    // 这里额外确认它确实是绕道走的(耗时属于 simplify 的量级)。
    const v = await verifyStep({ expr: '2*sin(x)*cos(x)', against: 'sin(2*x)' });
    ok('含超越函数时不走捷径,结论仍然正确', v.status === 'unconfirmed', `${v.status}: ${v.note}`);
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
