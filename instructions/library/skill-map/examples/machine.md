EXAMPLE: HOW A MACHINE IS BUILT

The request
"Research the mechanical structure and electrical assembly of an electric bicycle. Show every part with visuals and explain it in detail. Use the Anatomy and Hairline skills."

The plan, made before anything else
The bike has two systems, so the answer has a piece for each, and the two named skills each make their own figure:
1. A short opening: what an e-bike adds to a bicycle.
2. Anatomy: one detailed figure of the whole bike, frame and drivetrain, with the motor, battery and controller in place.
3. Data table: the mechanical parts, what each does.
4. Flow: the electrical assembly, how power and signals move from battery to motor.
5. Data table: the electrical parts, with typical ratings.
6. Hairline: one small figure of the throttle and the motor's power answering the pointer.
7. A closing table: what to check when buying or servicing.

The calls, in order
1. open_skill Anatomy. Its page sends you to the closest example and to references/craft.md.
2. open_skill_file anatomy-anatomy examples/dial-indicator/build.mjs (the smallest example, to see how a figure is built), then references/craft.md.
3. anatomy_build, when it is offered, with a build script written like the example, that makes the bike figure; mend what it reports with anatomy_change. When anatomy_build is not offered, write the whole figure as one SVG page yourself and put it in a Frame (see the Frame component page). Either way, build it from solids: a frame of tubes, two wheels with spokes and tyres, a crank with chainring, a hub motor in the rear wheel, a battery on the down tube, the controller under it, the display on the bar.
4. open_component Flow, then open_component Data.
5. open_skill Hairline Create, then open_skill_file hairline-hairline-create rules.md and examples/riffle.js.
6. hairline_build with the whole throttle figure. Fix what it reports and call it again.
Each skill and file is opened once.

The reply

An electric bicycle is an ordinary bicycle with three things added: a motor that pushes, a battery that feeds it, and a controller that decides how hard the motor pushes. Everything else, the frame, wheels, chain and brakes, is the bicycle you know, built a little stronger for the extra weight and speed.

**The whole bike**

[The Anatomy figure appears here: shown by anatomy_build, or as the Frame you wrote.]

The figure shows the bike from the drive side. The battery sits on the down tube, low and central, where its weight disturbs the handling least. The hub motor is inside the rear wheel. The controller is the small box under the battery, and the cables run inside the frame to the display on the handlebar.

**Mechanical parts**

```component
<Data>
  <Row part="Frame" whatItDoes="Holds everything; the down tube carries the battery" madeOf="Aluminium, sometimes steel or carbon" />
  <Row part="Fork" whatItDoes="Holds the front wheel and steers; often suspended" madeOf="Aluminium or steel" />
  <Row part="Wheels" whatItDoes="Spokes carry the load from rim to hub; thicker spokes on the motor wheel" madeOf="Aluminium rims, steel spokes" />
  <Row part="Drivetrain" whatItDoes="Crank, chainring, chain and cassette carry your pedalling to the rear wheel" madeOf="Steel and aluminium" />
  <Row part="Brakes" whatItDoes="Discs stop the extra weight; levers cut the motor when pulled" madeOf="Steel rotors, hydraulic callipers" />
</Data>
```

**Electrical assembly**

```component
<Flow height="420px" arrange="lr">
  <Group id="power" label="Power" color="warning" />
  <Group id="sense" label="Sensors" color="tertiary" />
  <Node id="battery" label="**Battery**&#10;36 V or 48 V lithium-ion" color="warning" group="power" />
  <Node id="bms" label="**BMS**&#10;guards each cell" color="surface" group="power" />
  <Node id="controller" label="**Controller**&#10;sets the motor current" color="primary" />
  <Node id="motor" label="**Hub motor**&#10;250 to 750 W" color="success" />
  <Node id="pas" label="Pedal sensor" color="surface" group="sense" />
  <Node id="throttle" label="Throttle" color="surface" group="sense" />
  <Node id="brake" label="Brake cut-off" color="surface" group="sense" />
  <Node id="display" label="**Display**&#10;speed, level, assist" color="secondary" />
  <Edge source="battery" target="bms" label="DC" />
  <Edge source="bms" target="controller" label="DC power" color="warning" width="3" />
  <Edge source="controller" target="motor" label="three-phase" color="success" width="3" animated="true" />
  <Edge source="pas" target="controller" label="pedalling" dashed="true" />
  <Edge source="throttle" target="controller" label="demand" dashed="true" />
  <Edge source="brake" target="controller" label="cut" dashed="true" color="error" />
  <Edge source="display" target="controller" label="assist level" start="filled" />
</Flow>
```

Power flows left to right: the battery, through its management board, to the controller, which turns steady DC into the three alternating currents that spin the motor. The dashed lines are signals, not power: the sensors tell the controller what you want, and the brake levers tell it to stop at once.

```component
<Data>
  <Row part="Battery" typical="36 V, 10 to 17 Ah" note="About 400 to 600 Wh; 40 to 100 km of assist" />
  <Row part="Controller" typical="15 to 25 A" note="Limits current so the motor and battery stay cool" />
  <Row part="Hub motor" typical="250 W in the EU, up to 750 W in the US" note="Brushless; geared hubs are lighter, direct drive lasts longer" />
  <Row part="Pedal sensor" typical="12 magnets on the crank" note="Torque sensors feel how hard you push and feel smoother" />
  <Row part="Display" typical="Assist 0 to 5" note="Also shows battery level and speed" />
</Data>
```

**Try the throttle**

[The Hairline figure appears here, shown by hairline_build.]

Move the pointer across the figure: the further the throttle turns, the more current the controller lets through, and the motor's arc grows with it. Let go and it springs back to rest, as the real throttle does.

**What to check**

| When | Check | Why |
|---|---|---|
| Buying | Battery capacity in Wh | It decides the range more than anything else |
| Buying | Motor position | Hub motors are simpler; mid-drive motors climb better |
| Monthly | Spoke tension on the motor wheel | The motor's torque loosens spokes faster |
| Monthly | Brake pads | The extra weight wears them faster |

What made this answer work
- Each named skill made its own piece; neither was asked to do the other's job.
- Each system got its own visual, and each visual has words saying what it shows.
- The plan came first, so each skill and file was opened once.
