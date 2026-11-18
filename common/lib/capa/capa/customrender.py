"""
This has custom renderers: classes that know how to render certain problem tags (e.g. <math> and
<solution>) to html.

These tags do not have state, so they just get passed the system (for access to render_template),
and the xml element.
"""


import hashlib
import logging
import re
import xml.sax.saxutils as saxutils
from urllib.parse import urlparse

from django.utils import html
from lxml import etree

from openedx.core.lib import edx_six

from .registry import TagRegistry

log = logging.getLogger(__name__)

registry = TagRegistry()


# -----------------------------------------------------------------------------


class MathRenderer(object):  # lint-amnesty, pylint: disable=missing-class-docstring
    tags = ['math']

    def __init__(self, system, xml):
        r"""
        Render math using latex-like formatting.

        Examples:

        <math>$\displaystyle U(r)=4 U_0 $</math>
        <math>$r_0$</math>

        We convert these to [mathjax]...[/mathjax] and [mathjaxinline]...[/mathjaxinline]

        TODO: use shorter tags (but this will require converting problem XML files!)
        """
        self.system = system
        self.xml = xml

        mathstr = re.sub(r'\$(.*)\$', r'[mathjaxinline]\1[/mathjaxinline]', xml.text)
        mtag = 'mathjax'
        if r'\displaystyle' not in mathstr:
            mtag += 'inline'
        else:
            mathstr = mathstr.replace(r'\displaystyle', '')
        self.mathstr = mathstr.replace('mathjaxinline]', '%s]' % mtag)

    def get_html(self):
        """
        Return the contents of this tag, rendered to html, as an etree element.
        """
        # TODO: why are there nested html tags here??  Why are there html tags at all, in fact?
        # xss-lint: disable=python-interpolate-html
        html = '<html><html>%s</html><html>%s</html></html>' % (  # lint-amnesty, pylint: disable=redefined-outer-name
            self.mathstr, saxutils.escape(self.xml.tail))
        try:
            xhtml = etree.XML(html)
        except Exception as err:  # lint-amnesty, pylint: disable=broad-except
            if self.system.DEBUG:
                # xss-lint: disable=python-interpolate-html
                msg = '<html><div class="inline-error"><p>Error %s</p>' % (
                    str(err).replace('<', '&lt;'))  # xss-lint: disable=python-custom-escape
                # xss-lint: disable=python-interpolate-html
                msg += ('<p>Failed to construct math expression from <pre>%s</pre></p>' %
                        html.replace('<', '&lt;'))  # xss-lint: disable=python-custom-escape
                msg += "</div></html>"
                log.error(msg)
                return etree.XML(msg)
            else:
                raise
        return xhtml


registry.register(MathRenderer)


# -----------------------------------------------------------------------------


class SolutionRenderer(object):
    """
    A solution is just a <span>...</span> which is given an ID, that is used for displaying an
    extended answer (a problem "solution") after "show answers" is pressed.

    Note that the solution content is NOT rendered and returned in the HTML. It is obtained by an
    ajax call.
    """
    tags = ['solution']

    def __init__(self, system, xml):
        self.system = system
        self.id = xml.get('id')

    def get_html(self):
        context = {'id': self.id}
        html = self.system.render_template("solutionspan.html", context)  # lint-amnesty, pylint: disable=redefined-outer-name
        return etree.XML(html)


registry.register(SolutionRenderer)


# -----------------------------------------------------------------------------


class TargetedFeedbackRenderer(object):
    """
    A targeted feedback is just a <span>...</span> that is used for displaying an
    extended piece of feedback to students if they incorrectly answered a question.
    """
    tags = ['targetedfeedback']

    def __init__(self, system, xml):
        self.system = system
        self.xml = xml

    def get_html(self):
        """
        Return the contents of this tag, rendered to html, as an etree element.
        """
        # xss-lint: disable=python-wrap-html
        html_str = '<section class="targeted-feedback-span"><span>{}</span></section>'.format(
            etree.tostring(self.xml, encoding='unicode'))
        try:
            xhtml = etree.XML(html_str)

        except Exception as err:  # pylint: disable=broad-except
            if self.system.DEBUG:
                # xss-lint: disable=python-wrap-html
                msg = """
                    <html>
                      <div class="inline-error">
                        <p>Error {err}</p>
                        <p>Failed to construct targeted feedback from <pre>{html}</pre></p>
                      </div>
                    </html>
                """.format(err=html.escape(err), html=html.escape(html_str))
                log.error(msg)
                return etree.XML(msg)
            else:
                raise
        return xhtml


registry.register(TargetedFeedbackRenderer)


# -----------------------------------------------------------------------------


class ClarificationRenderer(object):
    """
    A clarification appears as an inline icon which reveals more information when the user
    hovers over it.

    e.g. <p>Enter the ROA <clarification>Return on Assets</clarification> for 2015:</p>
    """
    tags = ['clarification']

    def __init__(self, system, xml):
        self.system = system
        # Get any text content found inside this tag prior to the first child tag. It may be a string or None type.
        initial_text = xml.text if xml.text else ''
        self.inner_html = initial_text + ''.join(etree.tostring(element, encoding='unicode') for element in xml)
        self.tail = xml.tail

    def get_html(self):
        """
        Return the contents of this tag, rendered to html, as an etree element.
        """
        context = {'clarification': self.inner_html}
        html = self.system.render_template("clarification.html", context)  # lint-amnesty, pylint: disable=redefined-outer-name
        xml = etree.XML(html)
        # We must include any text that was following our original <clarification>...</clarification> XML node.:
        xml.tail = self.tail
        return xml


registry.register(ClarificationRenderer)


# -----------------------------------------------------------------------------

#: Highest accepted ``allow-repeat`` value. Anything larger is an authoring mistake, not a real limit.
AUDIO_MAX_ALLOW_REPEAT = 1000

#: Values of the ``controls`` attribute that select the compact player (no progress bar).
AUDIO_CONTROLS_OFF = ('false', '0', 'no', 'off')

#: Seconds moved by the skip back / skip forward buttons (only shown when replays are unlimited).
AUDIO_SKIP_SECONDS = 10

#: Playback speeds offered by the speed select, as attribute values.
AUDIO_PLAYBACK_RATES = ('0.75', '1', '1.25', '1.5', '2')

# SVG paths of the player icons (24x24 viewBox), shared with the bunnynet-audio player.
_AUDIO_ICON_PATHS = {
    'play': 'M8 5v14l11-7z',
    'pause': 'M6 5h4v14H6zm8 0h4v14h-4z',
    'skip-back': 'M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
    'skip-forward': 'M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z',
    'volume': ('M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 '
               '13.4v2.1a9 9 0 0 0 0-17.6z'),
    'muted': ('M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 '
              '2.7-2.7 2.7 2.7 1.4-1.4z'),
}

# A ``type`` on <source> must look like a MIME type for audio, optionally with codecs parameters.
_AUDIO_MIME_RE = re.compile(r'^audio/[a-z0-9.+-]+(\s*;\s*codecs\s*=\s*"?[a-z0-9., +-]*"?)?$', re.IGNORECASE)


def validate_audio_src(src):
    """
    Return the cleaned audio URL, or None if it is not safe to put in a learner's page.

    Accepted:
        * absolute ``https://host/...`` URLs;
        * site-relative paths starting with a single ``/`` (e.g. ``/static/listening.mp3``,
          which the platform rewrites to the course asset URL).

    Everything else is rejected: other schemes (``javascript:``, ``data:``, ``http:``, ...),
    protocol-relative ``//host`` URLs, bare relative paths, and values containing whitespace,
    control characters or backslashes (browsers treat ``\\`` like ``/`` and strip some control
    characters before parsing, which can turn an innocent-looking value into another scheme).
    """
    if src is None:
        return None
    src = src.strip()
    if not src:
        return None
    if any(char.isspace() or ord(char) < 0x20 or ord(char) == 0x7f or char == '\\' for char in src):
        return None
    if src.startswith('/'):
        return None if src.startswith('//') else src
    try:
        parsed = urlparse(src)
    except ValueError:
        return None
    if parsed.scheme.lower() != 'https' or not parsed.hostname:
        return None
    return src


def parse_allow_repeat(value):
    """
    Parse the ``allow-repeat`` attribute.

    Returns a tuple ``(is_valid, limit)``. ``limit`` is the number of *additional* plays allowed
    after the first one, or None for unlimited. A missing or empty attribute means unlimited.
    """
    if value is None or not value.strip():
        return True, None
    value = value.strip()
    if not value.isdigit():
        return False, None
    limit = int(value)
    if limit > AUDIO_MAX_ALLOW_REPEAT:
        return False, None
    return True, limit


def audio_id(xml):
    """
    Return a stable identifier for an <audio> element of a problem.

    It keys the learner's replay counter (ProblemBlock.audio_plays) and is computed the same way when
    rendering and when the ``audio_play`` handler looks the element up again, so it must only depend on
    the problem XML. Built from the first source and the title rather than the element's position:
    positions shift when audio sits in parts rendered separately (solutions, hints). Two identical
    players in one problem share a counter.
    """
    src = xml.get('src')
    if src is None:
        source = xml.find('source')
        src = source.get('src') if source is not None else ''
    key = '{}\n{}'.format((src or '').strip(), (xml.get('title') or '').strip())
    return hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]


def _html_element(parent, tag, attributes, text=''):
    """
    Create an element whose text is never None, so lxml writes an explicit closing tag.

    lxml serializes an element without text or children as ``<tag/>``. Browsers parse that as an
    open tag for non-void elements such as <audio>, <div> or <span>, which then swallow everything
    that follows them.
    """
    element = etree.Element(tag) if parent is None else etree.SubElement(parent, tag)
    for name, value in attributes.items():
        element.set(name, value)
    element.text = text
    return element


def _void_element(parent, tag, attributes):
    """
    Create a void element (<input>, <source>). It has no closing tag, so lxml's ``<tag/>`` is correct.
    """
    element = etree.SubElement(parent, tag)
    for name, value in attributes.items():
        element.set(name, value)
    return element


def _svg_icon(parent, name):
    """
    Add an inline SVG icon. Inside <svg> browsers honour self-closing tags, but closing tags are
    written anyway for consistency.
    """
    svg = _html_element(parent, 'svg', {
        'class': 'capa-audio__icon capa-audio__icon--' + name,
        'viewBox': '0 0 24 24',
        'aria-hidden': 'true',
        'focusable': 'false',
    })
    _html_element(svg, 'path', {'d': _AUDIO_ICON_PATHS[name]})
    return svg


class AudioRenderer(object):
    """
    Embedded audio player for a question.

    e.g. <audio src="https://cdn.example.com/q1.mp3" allow-repeat="3" title="Conversation 1"/>

    Attributes:
        src           required (unless <source> children are given); https:// or /static/...
        allow-repeat  number of additional plays after the first one; omitted = unlimited
        title         accessible name of the player
        controls      "false" renders the compact player (play button and status only)

    Optional ``<source src="..." type="audio/ogg"/>`` children provide alternative formats.
    Every other attribute (autoplay, loop, event handlers, ...) and child is dropped: the output
    is built from scratch, never by copying the author's markup.

    The tag is rendered server side into markup that ``js/src/capa/audio.js`` turns into a player
    that enforces the replay limit. Without JavaScript the native browser controls are shown and
    the limit is not enforced. The limit is a learning-experience control, not a security boundary:
    the audio URL is always present in the page.

    Every non-void element gets explicit (possibly empty) text so that lxml serializes it with a
    closing tag. A self-closed ``<audio/>`` or ``<div/>`` is parsed by browsers as an open tag and
    swallows the rest of the question.
    """
    tags = ['audio']

    def __init__(self, system, xml):
        self.system = system
        self.xml = xml
        self.tail = xml.tail
        self._ = edx_six.get_gettext(system.i18n)

    def _sources(self):
        """
        Return the list of ``(src, mime_type_or_None)`` that passed validation, and the number rejected.
        """
        sources = []
        rejected = 0
        src_attr = self.xml.get('src')
        if src_attr is not None:
            src = validate_audio_src(src_attr)
            if src:
                sources.append((src, None))
            else:
                rejected += 1
        for source in self.xml.findall('source'):
            src = validate_audio_src(source.get('src'))
            mime_type = (source.get('type') or '').strip() or None
            if src and (mime_type is None or _AUDIO_MIME_RE.match(mime_type)):
                sources.append((src, mime_type))
            else:
                rejected += 1
        return sources, rejected

    def get_html(self):
        """
        Return the player markup as an etree element.
        """
        _ = self._
        sources, rejected = self._sources()
        valid_repeat, limit = parse_allow_repeat(self.xml.get('allow-repeat'))

        if not sources:
            if rejected:
                reason = _('the audio source must be an https:// URL or a /static/ file.')
            else:
                reason = _('no audio source was given.')
            return self._error(reason)
        if not valid_repeat:
            return self._error(
                _('allow-repeat must be a whole number from 0 to {maximum}.').format(maximum=AUDIO_MAX_ALLOW_REPEAT)
            )
        if rejected:
            log.info('Ignoring %d invalid audio source(s) in a problem', rejected)

        title = (self.xml.get('title') or '').strip() or _('Audio')
        compact = (self.xml.get('controls') or '').strip().lower() in AUDIO_CONTROLS_OFF

        root = _html_element(None, 'div', {
            'class': 'capa-audio' + (' capa-audio--compact' if compact else ''),
            'data-state': 'loading',
            'data-audio-id': audio_id(self.xml),
            'data-allow-repeat': 'unlimited' if limit is None else str(limit),
            'data-title': title,
            'data-skip-seconds': str(AUDIO_SKIP_SECONDS),
            'role': 'group',
            'aria-label': title,
        })
        player = _html_element(root, 'div', {'class': 'capa-audio__player'})
        self._add_media(player, sources)
        self._add_controls(player, title, limit is not None, compact)
        _html_element(player, 'p', {'class': 'capa-audio__status', 'role': 'status', 'aria-live': 'polite'})
        root.tail = self.tail
        return root

    def _add_media(self, root, sources):
        """
        Add the <audio> element. It keeps native controls so it stays usable if the script never runs;
        audio.js removes them once its own controls are in place.
        """
        fallback = self._('Your browser does not support the audio element.')
        attributes = {'class': 'capa-audio__media', 'preload': 'metadata', 'controls': 'controls'}
        if len(sources) == 1 and sources[0][1] is None:
            attributes['src'] = sources[0][0]
            _html_element(root, 'audio', attributes, text=fallback)
            return
        audio = _html_element(root, 'audio', attributes)
        for src, mime_type in sources:
            source = _void_element(audio, 'source', {'src': src})
            if mime_type:
                source.set('type', mime_type)
        source.tail = fallback

    def _add_controls(self, root, title, limited, compact):
        """
        Add the player's own controls, hidden until audio.js takes over.

        Layout follows the bunnynet-audio player: transport (play, skip back/forward), seek row
        (current time, seek bar, duration) and extras (mute/volume, playback speed). Seeking and the
        skip buttons exist only when replays are unlimited; with a limit the bar is display-only.
        The compact player has the play button only.
        """
        _ = self._
        controls = _html_element(root, 'div', {'class': 'capa-audio__controls', 'hidden': 'hidden'})
        transport = _html_element(controls, 'div', {'class': 'capa-audio__transport'})
        play = _html_element(transport, 'button', {
            'type': 'button',
            'class': 'capa-audio__btn capa-audio__btn--primary capa-audio__play',
            'disabled': 'disabled',
            'aria-label': _('Play {title}').format(title=title),
        })
        _svg_icon(play, 'play')
        _svg_icon(play, 'pause')
        if compact:
            return
        seconds = str(AUDIO_SKIP_SECONDS)
        if not limited:
            back = self._button(transport, 'capa-audio__skip-back', _('Back {seconds} seconds').format(seconds=seconds))
            _svg_icon(back, 'skip-back')
            _html_element(back, 'span', {'class': 'capa-audio__skip-label', 'aria-hidden': 'true'}, text=seconds)
            forward = self._button(
                transport, 'capa-audio__skip-forward', _('Forward {seconds} seconds').format(seconds=seconds)
            )
            _html_element(forward, 'span', {'class': 'capa-audio__skip-label', 'aria-hidden': 'true'}, text=seconds)
            _svg_icon(forward, 'skip-forward')
        self._add_seek_row(controls, limited)
        self._add_extras(controls)

    def _button(self, parent, class_name, label):
        """A disabled secondary player button; audio.js enables it once the audio is ready."""
        return _html_element(parent, 'button', {
            'type': 'button',
            'class': 'capa-audio__btn ' + class_name,
            'disabled': 'disabled',
            'aria-label': label,
        })

    def _add_seek_row(self, controls, limited):
        """Current time, seek bar (or display-only progress bar when limited) and duration."""
        _ = self._
        row = _html_element(controls, 'div', {'class': 'capa-audio__seek-row'})
        _html_element(row, 'span', {'class': 'capa-audio__time capa-audio__time--current', 'aria-hidden': 'true'},
                      text='--:--')
        if limited:
            progress = _html_element(row, 'div', {
                'class': 'capa-audio__progress',
                'role': 'progressbar',
                'aria-label': _('Playback progress'),
                'aria-valuemin': '0',
                'aria-valuemax': '0',
                'aria-valuenow': '0',
            })
            _html_element(progress, 'span', {'class': 'capa-audio__progress-fill'})
        else:
            _void_element(row, 'input', {
                'type': 'range',
                'class': 'capa-audio__seek',
                'min': '0',
                'max': '0',
                'step': 'any',
                'value': '0',
                'aria-label': _('Seek'),
                'disabled': 'disabled',
            })
        _html_element(row, 'span', {'class': 'capa-audio__time capa-audio__time--duration', 'aria-hidden': 'true'},
                      text='--:--')

    def _add_extras(self, controls):
        """Mute button with volume slider, and the playback speed select."""
        _ = self._
        extras = _html_element(controls, 'div', {'class': 'capa-audio__extras'})
        volume = _html_element(extras, 'div', {'class': 'capa-audio__volume'})
        mute = self._button(volume, 'capa-audio__mute', _('Mute'))
        _svg_icon(mute, 'volume')
        _svg_icon(mute, 'muted')
        _void_element(volume, 'input', {
            'type': 'range',
            'class': 'capa-audio__volume-slider',
            'min': '0',
            'max': '1',
            'step': '0.05',
            'value': '1',
            'aria-label': _('Volume'),
            'disabled': 'disabled',
        })
        speed = _html_element(extras, 'label', {'class': 'capa-audio__speed'})
        _html_element(speed, 'span', {'class': 'capa-audio__visually-hidden'}, text=_('Playback speed'))
        select = _html_element(speed, 'select', {'class': 'capa-audio__speed-select', 'disabled': 'disabled'})
        for rate in AUDIO_PLAYBACK_RATES:
            option = _html_element(select, 'option', {'value': rate}, text=rate + '\u00d7')
            if rate == '1':
                option.set('selected', 'selected')

    def _error(self, reason):
        """
        Markup shown instead of the player when the tag is unusable. No <audio> element is emitted.
        """
        log.info('Not rendering an embedded audio player: %s', reason)
        root = etree.Element('div')
        root.set('class', 'capa-audio capa-audio--error')
        root.set('data-state', 'error')
        message = etree.SubElement(root, 'p')
        message.set('class', 'capa-audio__status')
        message.set('role', 'alert')
        message.text = self._('Audio unavailable: {reason}').format(reason=reason)
        root.tail = self.tail
        return root


registry.register(AudioRenderer)
