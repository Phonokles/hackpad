import time

import board
import busio
import displayio
import keypad
import rotaryio
import terminalio
import usb_cdc

import adafruit_displayio_ssd1306
from adafruit_display_text import label

try:
    from i2cdisplaybus import I2CDisplayBus
except ImportError:
    from displayio import I2CDisplay as I2CDisplayBus


MENU = [
    ("auto",        "ACT",  "auto"),
    ("normal",      "EXPR", "normal"),
    ("lachen",      "EXPR", "laughing"),
    ("genervt",     "EXPR", "bored"),
    ("aufnahme",    "ACT",  "record"),
    ("transparent", "ACT",  "transparent"),
]

BUTTON_NAMES = ["btn1", "btn2", "btn3"]

MENU_TIMEOUT = 4.0


displayio.release_displays()

i2c = busio.I2C(board.D5, board.D4)
display_bus = I2CDisplayBus(i2c, device_address=0x3C)
display = adafruit_displayio_ssd1306.SSD1306(display_bus, width=128, height=32)

encoder = rotaryio.IncrementalEncoder(board.D0, board.D1)

# reihenfolge: SW1, SW2, SW3, encoder knopf
keys = keypad.Keys(
    (board.D10, board.D9, board.D8, board.D2),
    value_when_pressed=False,
    pull=True,
)
ENCODER_KEY = 3


group = displayio.Group()
lines = []
for row in range(3):
    text_line = label.Label(terminalio.FONT, text="", x=2, y=6 + row * 11)
    group.append(text_line)
    lines.append(text_line)
display.root_group = group


def show(row0="", row1="", row2=""):
    lines[0].text = row0
    lines[1].text = row1
    lines[2].text = row2


def draw_idle():
    show("   [ +_+ ]", "", "rad = menue")


def draw_talk():
    show("   [ +.+ ]", "", "reden...")


def draw_menu(selected):
    # fenster von drei eintraegen um die auswahl rum
    start = max(0, min(selected - 1, len(MENU) - 3))
    rows = []
    for offset in range(3):
        index = start + offset
        if index >= len(MENU):
            rows.append("")
            continue
        marker = ">" if index == selected else " "
        rows.append("{} {}".format(marker, MENU[index][0]))
    show(*rows)


def send(kind, value):
    if usb_cdc.data is None:
        return
    usb_cdc.data.write("{}:{}\n".format(kind, value).encode("utf-8"))


menu_open = False
selected = 0
last_position = encoder.position
last_activity = time.monotonic()

draw_idle()
send("READY", "hackpad")

while True:
    now = time.monotonic()

    position = encoder.position
    if position != last_position:
        delta = position - last_position
        last_position = position
        last_activity = now

        # erste drehung macht nur das menue auf
        if not menu_open:
            menu_open = True
        else:
            selected = (selected + delta) % len(MENU)

        draw_menu(selected)

    event = keys.events.get()
    if event is not None:
        last_activity = now

        if event.key_number == ENCODER_KEY:
            if menu_open:
                if event.pressed:
                    kind, value = MENU[selected][1], MENU[selected][2]
                    send(kind, value)
                    menu_open = False
                    show("", "  " + MENU[selected][0], "")
                    time.sleep(0.5)
                    draw_idle()
            else:
                # menue zu: knopf halten laesst den mund wackeln
                if event.pressed:
                    send("DOWN", "encoder")
                    draw_talk()
                else:
                    send("UP", "encoder")
                    draw_idle()
        else:
            name = BUTTON_NAMES[event.key_number]
            send("DOWN" if event.pressed else "UP", name)

    if menu_open and now - last_activity > MENU_TIMEOUT:
        menu_open = False
        draw_idle()

    time.sleep(0.005)