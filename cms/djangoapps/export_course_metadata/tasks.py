"""
This file exports metadata about the course
"""

import json

from celery import shared_task
from django.core.files.base import ContentFile
from opaque_keys.edx.keys import CourseKey
from openedx.core.djangoapps.schedules.content_highlights import get_all_course_highlights

from .storage import course_metadata_export_storage


@shared_task(bind=True)
def export_course_metadata_task(self, course_key_string):  # pylint: disable=unused-argument
    """
    Export course metadata

    File format
    '{"highlights": [["week1highlight1", "week1highlight2"], ["week1highlight1", "week1highlight2"], [], []]}'
    To retrieve highlights for week1, you would need to do
    course_metadata['highlights'][0]

    This data is initially being used by Braze Connected Content to include
    section highlights in emails, but may be used for other things in the future.
    """
    course_key = CourseKey.from_string(course_key_string)
    highlights = get_all_course_highlights(course_key)
    highlights_content = ContentFile(json.dumps({'highlights': highlights}))
    course_metadata_export_storage.save('course_metadata_export/{}.json'.format(course_key), highlights_content)
