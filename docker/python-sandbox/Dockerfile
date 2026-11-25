FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir pytest && \
    groupadd -g 1000 sandbox && \
    useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin sandbox && \
    mkdir -p /work /opt/sandbox && \
    chown 1000:1000 /work

COPY --chown=root:root harness.py /opt/sandbox/harness.py
RUN chmod 0555 /opt/sandbox/harness.py

WORKDIR /work
USER 1000:1000

ENTRYPOINT ["python3", "-B", "/opt/sandbox/harness.py"]
