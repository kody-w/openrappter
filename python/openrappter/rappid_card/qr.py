"""Scannable QR rendering backed by the qrcode ecosystem package."""

from __future__ import annotations

from io import BytesIO

import qrcode
import qrcode.image.svg

from .contract import parse_deep_link


def _qr(deep_link: str) -> qrcode.QRCode:
    exact = parse_deep_link(deep_link)["deepLink"]
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(exact)
    qr.make(fit=True)
    return qr


def render_rappid_card_qr_svg(deep_link: str) -> str:
    image = _qr(deep_link).make_image(
        image_factory=qrcode.image.svg.SvgPathImage
    )
    output = BytesIO()
    image.save(output)
    return output.getvalue().decode("utf-8")


def render_rappid_card_qr_png(deep_link: str) -> bytes:
    image = _qr(deep_link).make_image(fill_color="black", back_color="white")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
