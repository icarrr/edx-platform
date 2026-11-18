"""
Tests for embedded <audio> in capa problems (capa.customrender.AudioRenderer).
"""

import re
import textwrap

import html5lib
import pytest
from lxml import etree

from capa import customrender
from capa.customrender import AudioRenderer, audio_id, parse_allow_repeat, validate_audio_src
from capa.tests.helpers import new_loncapa_problem
from capa.tests.helpers import test_capa_system as capa_system

HTML_NS = '{http://www.w3.org/1999/xhtml}'

MC_PROBLEM = textwrap.dedent("""\
    <problem>
        <p>Listen to the audio and answer the following question.</p>
        {audio}
        <multiplechoiceresponse>
            {inner_audio}
            <p>What does the speaker want to do?</p>
            <choicegroup type="MultipleChoice">
                <choice correct="false">Go to the library</choice>
                <choice correct="true">Visit a friend</choice>
                <choice correct="false">Buy some food</choice>
                <choice correct="false">Attend a meeting</choice>
            </choicegroup>
        </multiplechoiceresponse>
    </problem>
""")


def render(xml_string):
    """Render a single <audio> snippet and return (element, serialized html)."""
    element = AudioRenderer(capa_system(), etree.XML(xml_string)).get_html()
    return element, etree.tostring(element).decode('utf-8')


def browser_parse(html):
    """Parse HTML the way a browser does (HTML5 algorithm), returning an etree."""
    return html5lib.parse(html, namespaceHTMLElements=True)


# ------------------------------------------------------------------ validation helpers

@pytest.mark.parametrize('src, expected', [
    ('https://cdn.example.com/audio/q1.mp3', 'https://cdn.example.com/audio/q1.mp3'),
    ('  https://cdn.example.com/a.mp3  ', 'https://cdn.example.com/a.mp3'),
    ('HTTPS://cdn.example.com/a.mp3', 'HTTPS://cdn.example.com/a.mp3'),
    ('https://cdn.example.com/a.mp3?token=abc#t=10', 'https://cdn.example.com/a.mp3?token=abc#t=10'),
    ('/static/listening/q1.mp3', '/static/listening/q1.mp3'),
    ('/asset-v1:Org+Course+Run+type@asset+block@q1.mp3', '/asset-v1:Org+Course+Run+type@asset+block@q1.mp3'),
    (None, None),
    ('', None),
    ('   ', None),
    ('javascript:alert(1)', None),
    ('JavaScript:alert(1)', None),
    (' javascript:alert(1)', None),
    ('java\tscript:alert(1)', None),
    ('data:audio/mp3;base64,AAAA', None),
    ('vbscript:msgbox(1)', None),
    ('http://cdn.example.com/a.mp3', None),
    ('ftp://cdn.example.com/a.mp3', None),
    ('//cdn.example.com/a.mp3', None),
    ('/\\cdn.example.com/a.mp3', None),
    ('https:/\\cdn.example.com/a.mp3', None),
    ('https:///a.mp3', None),
    ('audio/q1.mp3', None),
    ('q1.mp3', None),
    ('https://cdn.example.com/a b.mp3', None),
])
def test_validate_audio_src(src, expected):
    assert validate_audio_src(src) == expected


@pytest.mark.parametrize('value, expected', [
    (None, (True, None)),
    ('', (True, None)),
    ('  ', (True, None)),
    ('0', (True, 0)),
    ('3', (True, 3)),
    (' 3 ', (True, 3)),
    ('1000', (True, 1000)),
    ('1001', (False, None)),
    ('-1', (False, None)),
    ('2.5', (False, None)),
    ('abc', (False, None)),
    ('unlimited', (False, None)),
])
def test_parse_allow_repeat(value, expected):
    assert parse_allow_repeat(value) == expected


def test_audio_id_is_stable_and_depends_on_source_and_title():
    first = audio_id(etree.XML('<audio src="https://cdn.example.com/a.mp3" title="One" allow-repeat="1"/>'))
    same = audio_id(etree.XML('<audio title="One" allow-repeat="5" src=" https://cdn.example.com/a.mp3 "/>'))
    other_src = audio_id(etree.XML('<audio src="https://cdn.example.com/b.mp3" title="One"/>'))
    other_title = audio_id(etree.XML('<audio src="https://cdn.example.com/a.mp3" title="Two"/>'))
    from_source = audio_id(etree.XML('<audio><source src="https://cdn.example.com/a.mp3"/></audio>'))
    assert first == same
    assert len({first, other_src, other_title, from_source}) == 4
    assert re.match(r'^[0-9a-f]{16}$', first)


def test_player_carries_its_audio_id():
    xml_string = '<audio src="https://cdn.example.com/a.mp3" allow-repeat="1"/>'
    element, _html = render(xml_string)
    assert element.get('data-audio-id') == audio_id(etree.XML(xml_string))


def test_simple_editor_shortcut_output_renders_a_player():
    # What the Studio Simple editor writes for
    # [[audio https://vz-...b-cdn.net/.../playlist.m3u8 | repeat=2 | Conversation 1]] (problem/edit.js audioToXml).
    url = 'https://vz-89e131f7-dd6.b-cdn.net/cf947d12-898e-4354-9742-95f6de7bf361/playlist.m3u8?a=1&amp;b=2'
    element, html = render('<audio src="{}" allow-repeat="2" title="Conversation 1"/>'.format(url))
    assert 'capa-audio--error' not in element.get('class')
    assert element.get('data-allow-repeat') == '2'
    assert element.get('data-title') == 'Conversation 1'
    assert 'playlist.m3u8?a=1&amp;b=2' in html


def test_audio_tag_is_registered():
    assert 'audio' in customrender.registry.registered_tags()
    assert customrender.registry.get_class_for_tag('audio') is AudioRenderer


# ------------------------------------------------------------------ renderer output

def by_class(element, class_name):
    """Return the descendants whose class list contains class_name."""
    return [node for node in element.iter() if class_name in (node.get('class') or '').split()]


def test_renders_player_markup():
    element, html = render('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="3" title="Conversation 1"/>')

    assert element.tag == 'div'
    assert element.get('class') == 'capa-audio'
    assert element.get('data-allow-repeat') == '3'
    assert element.get('data-title') == 'Conversation 1'
    assert element.get('data-skip-seconds') == '10'
    assert element.get('aria-label') == 'Conversation 1'
    audio = element.find('.//audio')
    assert audio.get('src') == 'https://cdn.example.com/q1.mp3'
    assert audio.get('preload') == 'metadata'
    # Native controls stay as the no-JavaScript fallback; audio.js removes them.
    assert audio.get('controls') == 'controls'
    [play] = by_class(element, 'capa-audio__play')
    assert play.tag == 'button'
    assert play.get('type') == 'button'
    assert play.get('aria-label') == 'Play Conversation 1'
    assert [svg.get('class') for svg in play.findall('svg')] == [
        'capa-audio__icon capa-audio__icon--play', 'capa-audio__icon capa-audio__icon--pause',
    ]
    assert element.find(".//*[@role='status']") is not None
    # Every non-void element is closed explicitly; a self-closed <audio/> or <div/> breaks HTML parsing.
    assert '</audio>' in html
    assert '<input' in html
    assert '</input>' not in html
    # Only void elements (<input>) may be self-closed.
    assert '/>' not in re.sub(r'<(input|source)\b[^>]*/>', '', html)


def test_limited_player_has_display_only_progress_and_no_seeking():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="2"/>')
    [progress] = by_class(element, 'capa-audio__progress')
    assert progress.get('role') == 'progressbar'
    assert by_class(element, 'capa-audio__progress-fill')
    assert not by_class(element, 'capa-audio__seek')
    assert not by_class(element, 'capa-audio__skip-back')
    assert not by_class(element, 'capa-audio__skip-forward')
    assert by_class(element, 'capa-audio__time--current')[0].text == '--:--'
    assert by_class(element, 'capa-audio__time--duration')[0].text == '--:--'


def test_unlimited_player_has_seek_bar_and_skip_buttons():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3" title="Clip"/>')
    [seek] = by_class(element, 'capa-audio__seek')
    assert seek.tag == 'input'
    assert seek.get('type') == 'range'
    assert seek.get('disabled') == 'disabled'
    assert not by_class(element, 'capa-audio__progress')
    [back] = by_class(element, 'capa-audio__skip-back')
    [forward] = by_class(element, 'capa-audio__skip-forward')
    assert back.get('aria-label') == 'Back 10 seconds'
    assert forward.get('aria-label') == 'Forward 10 seconds'
    assert [node.text for node in by_class(element, 'capa-audio__skip-label')] == ['10', '10']


@pytest.mark.parametrize('allow_repeat', ['', ' allow-repeat="1"'])
def test_mute_volume_and_speed_controls(allow_repeat):
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3"{}/>'.format(allow_repeat))
    [mute] = by_class(element, 'capa-audio__mute')
    assert mute.get('aria-label') == 'Mute'
    assert [svg.get('class').split()[-1] for svg in mute.findall('svg')] == [
        'capa-audio__icon--volume', 'capa-audio__icon--muted',
    ]
    [volume] = by_class(element, 'capa-audio__volume-slider')
    assert (volume.get('type'), volume.get('min'), volume.get('max'), volume.get('value')) == ('range', '0', '1', '1')
    [select] = by_class(element, 'capa-audio__speed-select')
    options = select.findall('option')
    assert [option.get('value') for option in options] == ['0.75', '1', '1.25', '1.5', '2']
    assert [option.text for option in options] == ['0.75\u00d7', '1\u00d7', '1.25\u00d7', '1.5\u00d7', '2\u00d7']
    assert [option.get('value') for option in options if option.get('selected')] == ['1']
    assert by_class(element, 'capa-audio__speed')[0].find('span').text == 'Playback speed'
    # Every control starts disabled; audio.js enables them once the audio can play.
    for control in by_class(element, 'capa-audio__btn') + [volume, select]:
        assert control.get('disabled') == 'disabled'


def test_allow_repeat_omitted_means_unlimited():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3"/>')
    assert element.get('data-allow-repeat') == 'unlimited'


def test_allow_repeat_zero_means_single_play():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="0"/>')
    assert element.get('data-allow-repeat') == '0'


def test_default_title():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3"/>')
    assert element.get('data-title') == 'Audio'


def test_compact_player_has_play_button_only():
    element, _ = render('<audio src="https://cdn.example.com/q1.mp3" controls="false"/>')
    assert 'capa-audio--compact' in element.get('class')
    assert len(by_class(element, 'capa-audio__play')) == 1
    for absent in ('capa-audio__seek-row', 'capa-audio__progress', 'capa-audio__seek', 'capa-audio__time',
                   'capa-audio__skip-back', 'capa-audio__extras', 'capa-audio__mute', 'capa-audio__speed-select'):
        assert not by_class(element, absent), absent
    assert element.find(".//*[@role='status']") is not None


def test_unknown_attributes_and_children_are_dropped():
    _, html = render(
        '<audio src="https://cdn.example.com/q1.mp3" autoplay="autoplay" loop="loop" '
        'onplay="alert(1)" style="display:none" class="x"><p onclick="alert(2)">fallback</p></audio>'
    )
    for unwanted in ('autoplay', 'loop', 'onplay', 'onclick', 'display:none', 'alert', 'fallback'):
        assert unwanted not in html


def test_title_is_escaped():
    _, html = render(
        '<audio src="https://cdn.example.com/q1.mp3" title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/>'
    )
    assert '<script>' not in html
    assert '&lt;script&gt;' in html
    body = browser_parse('<div>' + html + '</div>')
    assert body.find('.//' + HTML_NS + 'script') is None


def test_source_children_for_alternative_formats():
    element, _ = render(
        '<audio title="Q1">'
        '<source src="https://cdn.example.com/q1.ogg" type="audio/ogg"/>'
        '<source src="https://cdn.example.com/q1.mp3" type="audio/mpeg"/>'
        '<source src="javascript:alert(1)" type="audio/mpeg"/>'
        '<source src="https://cdn.example.com/q1.bin" type="text/html"/>'
        '</audio>'
    )
    audio = element.find('.//audio')
    assert audio.get('src') is None
    assert [(s.get('src'), s.get('type')) for s in audio.findall('source')] == [
        ('https://cdn.example.com/q1.ogg', 'audio/ogg'),
        ('https://cdn.example.com/q1.mp3', 'audio/mpeg'),
    ]


def test_src_and_source_children_combined():
    element, _ = render(
        '<audio src="https://cdn.example.com/q1.mp3"><source src="https://cdn.example.com/q1.ogg"/></audio>'
    )
    assert [s.get('src') for s in element.find('.//audio').findall('source')] == [
        'https://cdn.example.com/q1.mp3', 'https://cdn.example.com/q1.ogg',
    ]


@pytest.mark.parametrize('xml_string, message', [
    ('<audio src="javascript:alert(1)"/>', 'https:// URL or a /static/ file'),
    ('<audio src="http://cdn.example.com/q1.mp3"/>', 'https:// URL or a /static/ file'),
    ('<audio src=""/>', 'https:// URL or a /static/ file'),
    ('<audio/>', 'no audio source was given'),
    ('<audio title="no source"></audio>', 'no audio source was given'),
    ('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="-1"/>', 'allow-repeat must be a whole number'),
    ('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="abc"/>', 'allow-repeat must be a whole number'),
    ('<audio src="https://cdn.example.com/q1.mp3" allow-repeat="5000"/>', 'allow-repeat must be a whole number'),
])
def test_invalid_audio_renders_error_without_media(xml_string, message):
    element, html = render(xml_string)
    assert 'capa-audio--error' in element.get('class')
    assert element.find('.//audio') is None
    assert 'javascript' not in html
    assert message in html


def test_tail_text_is_kept():
    parent = etree.XML('<p>Before <audio src="https://cdn.example.com/q1.mp3"/> after the audio.</p>')
    element = AudioRenderer(capa_system(), parent[0]).get_html()
    assert element.tail == ' after the audio.'


# ------------------------------------------------------------------ inside a full problem

def _problem_html(audio='', inner_audio=''):
    return new_loncapa_problem(MC_PROBLEM.format(audio=audio, inner_audio=inner_audio)).get_html()


def test_problem_without_audio_has_no_player():
    html = _problem_html()
    assert 'capa-audio' not in html
    assert '<audio' not in html


def test_audio_inside_response_does_not_swallow_the_question():
    html = _problem_html(inner_audio='<audio src="https://cdn.example.com/q1.mp3" allow-repeat="3"/>')
    document = browser_parse(html)

    audios = document.findall('.//' + HTML_NS + 'audio')
    assert len(audios) == 1
    # In a browser, the question text and the choices must stay outside the <audio> element.
    assert not [el for el in audios[0].iter() if el.tag in (HTML_NS + 'p', HTML_NS + 'div')]
    response = document.find(".//*[@class='wrapper-problem-response']")
    assert response is not None
    assert response.find('.//' + HTML_NS + 'audio') is not None
    assert 'What does the speaker want to do?' in ''.join(response.itertext())


def test_raw_self_closed_audio_would_swallow_siblings():
    """Documents why the renderer exists: lxml writes <audio/>, which browsers treat as an open tag."""
    raw = etree.tostring(etree.XML('<div><audio src="https://x/a.mp3"/><p>Question</p></div>')).decode('utf-8')
    audio = browser_parse(raw).find('.//' + HTML_NS + 'audio')
    assert audio.find(HTML_NS + 'p') is not None


def test_multiple_audio_elements_render_independently():
    html = _problem_html(
        audio='<audio src="https://cdn.example.com/intro.mp3" title="Intro"/>',
        inner_audio=(
            '<audio src="https://cdn.example.com/q1-a.mp3" allow-repeat="1" title="Speaker A"/>'
            '<audio src="https://cdn.example.com/q1-b.mp3" allow-repeat="3" title="Speaker B"/>'
        ),
    )
    document = browser_parse(html)
    players = [el for el in document.iter() if 'capa-audio' in (el.get('class') or '').split()]
    assert [p.get('data-title') for p in players] == ['Intro', 'Speaker A', 'Speaker B']
    assert [p.get('data-allow-repeat') for p in players] == ['unlimited', '1', '3']
    assert [p.find('.//' + HTML_NS + 'audio').get('src') for p in players] == [
        'https://cdn.example.com/intro.mp3', 'https://cdn.example.com/q1-a.mp3', 'https://cdn.example.com/q1-b.mp3',
    ]
    # Still one question with its choices.
    assert html.count('Visit a friend') == 1


@pytest.mark.parametrize('audio, inner_audio', [
    ('', ''),
    ('<audio src="https://cdn.example.com/intro.mp3"/>', ''),
    ('', '<audio src="https://cdn.example.com/q1.mp3" allow-repeat="3"/>'),
    ('', '<audio src="javascript:alert(1)"/>'),
])
def test_grading_is_unchanged_by_audio(audio, inner_audio):
    xml = MC_PROBLEM.format(audio=audio, inner_audio=inner_audio)

    correct = new_loncapa_problem(xml).grade_answers({'1_2_1': 'choice_1'})
    assert correct.get_correctness('1_2_1') == 'correct'

    incorrect = new_loncapa_problem(xml).grade_answers({'1_2_1': 'choice_0'})
    assert incorrect.get_correctness('1_2_1') == 'incorrect'

    problem = new_loncapa_problem(xml)
    assert problem.get_max_score() == 1
    assert list(problem.responders.values())[0].get_answers() == {'1_2_1': ['choice_1']}


def test_audio_does_not_add_inputs():
    with_audio = new_loncapa_problem(MC_PROBLEM.format(
        audio='<audio src="https://cdn.example.com/intro.mp3"/>',
        inner_audio='<audio src="https://cdn.example.com/q1.mp3" allow-repeat="2"/>',
    ))
    without_audio = new_loncapa_problem(MC_PROBLEM.format(audio='', inner_audio=''))
    assert list(with_audio.inputs.keys()) == list(without_audio.inputs.keys())
    assert list(with_audio.responders.keys())[0].get('id') == list(without_audio.responders.keys())[0].get('id')


def test_audio_in_choice_feedback_problem_keeps_targeted_feedback():
    xml = textwrap.dedent("""\
        <problem>
            <multiplechoiceresponse targeted-feedback="">
                <audio src="https://cdn.example.com/q1.mp3" allow-repeat="1"/>
                <label>Which one?</label>
                <choicegroup type="MultipleChoice">
                    <choice correct="false" explanation-id="feedback1">Wrong</choice>
                    <choice correct="true" explanation-id="feedback2">Right</choice>
                </choicegroup>
            </multiplechoiceresponse>
            <targetedfeedbackset>
                <targetedfeedback explanation-id="feedback1"><p>Not quite.</p></targetedfeedback>
                <targetedfeedback explanation-id="feedback2"><p>Well done.</p></targetedfeedback>
            </targetedfeedbackset>
        </problem>
    """)
    problem = new_loncapa_problem(xml)
    problem.done = True
    problem.student_answers = {'1_2_1': 'choice_0'}
    html = problem.get_html()
    assert 'Not quite.' in html
    assert 'Well done.' not in html
    assert 'capa-audio' in html
