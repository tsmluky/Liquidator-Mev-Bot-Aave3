# Liquidador de Aave V3

> Bot que detecta posiciones de préstamo por debajo del umbral de liquidación en Aave V3 y
> las liquida en una sola transacción atómica. Arbitrum y Base.

## Por qué existe

En un protocolo de préstamo como Aave, cuando la garantía de alguien cae por debajo del
umbral, cualquiera puede liquidar su posición: repagas parte de su deuda y te llevas la
garantía con descuento. El protocolo lo necesita para no acumular deuda incobrable.

El problema es que hay dos cosas que compiten entre sí. Puedes reaccionar **rápido**, y
entonces no te da tiempo a calcular bien si la operación sale a cuenta. O puedes calcular
**bien**, y entonces llegas tarde.

Este bot separa las dos cosas en tres procesos que corren a la vez y no se bloquean entre
ellos.

## Los tres procesos

**Explorador.** Descubre prestatarios. Recorre los logs de la cadena al ritmo del bloque y,
en paralelo, hace un barrido histórico de hasta 50.000 bloques por ciclo para encontrar
posiciones antiguas que un bot que solo mira el presente nunca ve. Escribe lo que encuentra
en un `candidates.jsonl` append-only, así que nunca se bloquea escribiendo.

**Vigía.** No mira toda la cadena: solo las posiciones que el Explorador marcó como
arriesgadas. Al reducir el conjunto, puede consultarlas con mucha más frecuencia sin
disparar el consumo de RPC. Cuando un health factor baja de 1, avisa al Ejecutor.

**Ejecutor.** Decide y ejecuta. Replica en local la aritmética del health factor de Aave, así
que puede valorar una posición sin una sola llamada RPC y reaccionar en el momento en que
cambia un precio. Si sale a cuenta, lanza la transacción.

## La liquidación, paso a paso

Todo ocurre dentro de una sola transacción, en un contrato en Solidity. Si algo falla a
medio camino, revierte entero y no se pierde nada más que el gas:

1. Pide un préstamo relámpago a Aave con `flashLoanSimple`.
2. Liquida la posición y recibe la garantía con descuento.
3. Cambia esa garantía por el activo de la deuda.
4. Devuelve el préstamo relámpago.
5. Lo que sobra se queda en la tesorería.

Como el principal sale del propio préstamo relámpago, **no hace falta capital propio** para
la operación: solo para pagar el gas.

La comisión de prioridad no es fija. Se calcula como un porcentaje del beneficio neto
estimado de esa liquidación concreta, de modo que en un objetivo grande puede pujar fuerte y
en uno pequeño no se come el margen.

## Estado

Contrato desplegado en **Arbitrum One** (`hardhat/deployments/arbitrumOne.json`). El
repositorio incluye los datos de ejecución reales en `data/runtime/`. Es un proyecto
personal, no un servicio: **nadie lo ha auditado** y no está mantenido.

## Puesta en marcha

Requiere Node.js 18 o superior, pnpm y una URL de RPC de Arbitrum o Base.

```bash
pnpm install
cp .env.example .env
```

Rellena `RPC_URL` y `PRIVATE_KEY` en el `.env`. La clave privada nunca se versiona.

```bash
pnpm test
```

Los tres procesos van en tres terminales: `./run_miner.ps1` para el Explorador,
`./run_sentry.ps1` para el Vigía y `./run_strategy.ps1` para el Ejecutor.
`Start_Aave_Bot.bat` los levanta los tres de golpe.

La CLI también se puede usar suelta, que es lo cómodo para probar sin arrancar la flota:

```bash
pnpm preflight     # comprueba configuración y conexión
pnpm scan          # busca posiciones liquidables
pnpm plan          # construye el plan de transacción
pnpm simulate      # lo simula sin firmar nada
pnpm execute       # lo ejecuta de verdad
```

## Estructura

```
data/         Estado en ejecución: candidatos, estadísticas, planes de transacción
hardhat/      Contratos en Solidity, despliegue y tareas
ops/          Scripts de operación en PowerShell
src/
  commands/   Comandos de la CLI (scan, plan, simulate, exec, preflight)
  lib/        Aritmética de Aave y búsqueda de rutas
  services/   Acceso a datos de la cadena
test/         Pruebas con el runner nativo de Node y tsx
```

## Stack

TypeScript sobre Node.js. **Viem** para hablar con la cadena, que es bastante más rápido que
ethers.js. Solidity 0.8.x para el contrato de ejecución, con Hardhat para desplegarlo y
probarlo. PowerShell para orquestar los procesos.

## Aviso

Código abierto con fines demostrativos. Opera con dinero real sobre contratos reales y
emplea estrategias de MEV. Sin auditar y sin garantías: si lo ejecutas, es bajo tu
responsabilidad.

Escrito por Francisco Iannicelli · [github.com/tsmluky](https://github.com/tsmluky)
